// bot/status.js — posts a live status embed every 15 minutes and announces incidents / recoveries.
// Each new embed (and problem/resolved message) replaces the previous one.
const { EmbedBuilder } = require('discord.js');
const { pool } = require('../db');

const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID || '1559938680725049424';
const API_URL = (process.env.API_URL || 'https://practical-analysis-production-df21.up.railway.app').replace(/\/+$/, '');
const INTERVAL_MS = 15 * 60 * 1000;
const CHECK_TIMEOUT_MS = 8000;
const RETENTION_DAYS = 30; // uptime is computed over this window
const PROBE_KEY = '__status_probe__'; // the API answers it without writing a failed-verify log

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function httpFetch(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- the systems being checked ----------

function buildServices(client) {
  return [
    {
      name: 'API',
      check: async () => {
        const res = await httpFetch(`${API_URL}/health`);
        const body = await res.json();
        if (!res.ok || body.status !== 'up') throw new Error(`unexpected response (${res.status})`);
      },
    },
    {
      name: 'Database',
      check: async () => {
        await pool.query('SELECT 1');
      },
    },
    {
      // the exact endpoint the Roblox script calls; a healthy /verify answers the probe with 404 invalid_key
      name: 'Authentication',
      check: async () => {
        const res = await httpFetch(`${API_URL}/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: PROBE_KEY, hwid: 'status-probe' }),
        });
        const body = await res.json();
        if (res.status === 503 && body.reason === 'maintenance') return; // API is answering, it's just in maintenance
        if (res.status !== 404 || body.reason !== 'invalid_key') {
          throw new Error(`unexpected response (${res.status})`);
        }
      },
    },
    {
      // a real lookup on the keys table
      name: 'Licensing',
      check: async () => {
        await pool.query('SELECT 1 FROM keys WHERE key_value = $1 LIMIT 1', [PROBE_KEY]);
      },
    },
    {
      // gateway connection state + websocket ping
      name: 'Discord Bot',
      check: async () => {
        if (!client.isReady()) throw new Error(`gateway not ready (ws status ${client.ws.status})`);
        if (client.ws.ping >= 0) return client.ws.ping;
        // right after a restart the first heartbeat hasn't been acknowledged yet (ping is -1):
        // measure a REST round trip to Discord instead of reporting the bot as down
        const start = Date.now();
        await client.rest.get('/gateway');
        return Date.now() - start;
      },
    },
  ];
}

// One retry before a system is declared down, so a single blip doesn't trigger an incident
async function runCheck(service) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const start = Date.now();
    try {
      const result = await withTimeout(service.check(), CHECK_TIMEOUT_MS);
      const latency = typeof result === 'number' ? result : Date.now() - start;
      return { name: service.name, ok: true, latency: Math.max(1, Math.round(latency)) };
    } catch (err) {
      if (attempt === 2) {
        console.error(`Status: ${service.name} check failed:`, err.message);
        return { name: service.name, ok: false, latency: null };
      }
      await sleep(2000);
    }
  }
}

// ---------- history (for uptime %) ----------

// Results wait here until they're written, so downtime of the database itself is still counted afterwards
const pendingChecks = [];

async function recordAndGetUptime() {
  try {
    while (pendingChecks.length) {
      const r = pendingChecks[0];
      await pool.query(
        'INSERT INTO status_checks (service, ok, latency_ms, checked_at) VALUES ($1, $2, $3, $4)',
        [r.name, r.ok, r.latency, r.at]
      );
      pendingChecks.shift();
    }
    await pool.query(
      `DELETE FROM status_checks WHERE checked_at < NOW() - ($1 || ' days')::interval`,
      [String(RETENTION_DAYS)]
    );
    const { rows } = await pool.query(
      `SELECT service, COUNT(*)::int AS total, (COUNT(*) FILTER (WHERE ok))::int AS up
       FROM status_checks
       WHERE checked_at > NOW() - ($1 || ' days')::interval
       GROUP BY service`,
      [String(RETENTION_DAYS)]
    );
    const uptime = {};
    for (const r of rows) uptime[r.service] = r.total ? (r.up / r.total) * 100 : 100;
    return uptime;
  } catch (err) {
    console.error('Status: could not record/read history:', err.message);
    return null;
  }
}

// ---------- message state (survives restarts, so the old embed can still be deleted) ----------

const state = { loaded: false, embedId: null, noticeId: null, incident: null };

async function loadState() {
  try {
    const { rows } = await pool.query(`SELECT k, v FROM bot_state WHERE k LIKE 'status_%'`);
    for (const r of rows) {
      if (r.k === 'status_embed_id' && !state.embedId) state.embedId = r.v || null;
      if (r.k === 'status_notice_id' && !state.noticeId) state.noticeId = r.v || null;
      if (r.k === 'status_incident' && !state.incident) state.incident = r.v ? JSON.parse(r.v) : null;
    }
    state.loaded = true;
  } catch (err) {
    console.error('Status: could not load state:', err.message);
  }
}

async function saveState() {
  const entries = [
    ['status_embed_id', state.embedId || ''],
    ['status_notice_id', state.noticeId || ''],
    ['status_incident', state.incident ? JSON.stringify(state.incident) : ''],
  ];
  try {
    for (const [k, v] of entries) {
      await pool.query(
        'INSERT INTO bot_state (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v',
        [k, v]
      );
    }
  } catch (err) {
    console.error('Status: could not save state:', err.message);
  }
}

async function deleteMessage(channel, id) {
  if (!id) return;
  try {
    await channel.messages.delete(id);
  } catch (_) {
    // already deleted, nothing to do
  }
}

// Maintenance mode is switched with /maintenance and stored in bot_state
async function getMaintenance() {
  try {
    const { rows } = await pool.query(
      `SELECT k, v FROM bot_state WHERE k IN ('maintenance', 'maintenance_message')`
    );
    const map = Object.fromEntries(rows.map((r) => [r.k, r.v]));
    return { on: map.maintenance === 'on', message: map.maintenance_message || '' };
  } catch (_) {
    return { on: false, message: '' };
  }
}

const SERVICE_ORDER = ['API', 'Database', 'Authentication', 'Licensing', 'Discord Bot'];

// ---------- formatting ----------

function formatDuration(ms) {
  const totalMin = Math.max(1, Math.round(ms / 60000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || !parts.length) parts.push(`${m}m`);
  return parts.join(' ');
}

const fmtPct = (p) => `${Number(p.toFixed(1))}%`;

function buildEmbed(results, uptime, maint = { on: false, message: '' }) {
  const down = results.filter((r) => !r.ok);
  let label = 'Operational';
  let color = 0x2ecc71;
  if (maint.on) {
    label = 'Maintenance';
    color = 0x3498db;
  } else if (down.length === results.length) {
    label = 'Major outage';
    color = 0xe74c3c;
  } else if (down.length) {
    label = 'Partial outage';
    color = 0xf39c12;
  }

  const lines = results.map((r) => {
    const up = uptime && uptime[r.name] !== undefined ? `${fmtPct(uptime[r.name])} uptime` : 'uptime n/a';
    return `${r.ok ? '🟢' : '🔴'} **${r.name}** · ${up} · ${r.ok ? `${r.latency}ms` : 'Down'}`;
  });

  const header = maint.on
    ? `🔧 **Scheduled maintenance in progress**${maint.message ? `\n${maint.message}` : ''}\n\n`
    : '';

  return new EmbedBuilder()
    .setTitle(`Ibuprofen Status — ${label}`)
    .setDescription(header + lines.join('\n'))
    .setColor(color)
    .setFooter({ text: 'Updates every 15 min' })
    .setTimestamp();
}

// ---------- one monitoring cycle ----------

let running = false;

async function runCycle(client) {
  if (running) return;
  running = true;
  try {
    if (!state.loaded) await loadState();

    const results = await Promise.all(buildServices(client).map(runCheck));
    const now = new Date();
    for (const r of results) pendingChecks.push({ name: r.name, ok: r.ok, latency: r.latency, at: now });
    if (pendingChecks.length > 500) pendingChecks.splice(0, pendingChecks.length - 500);

    const uptime = await recordAndGetUptime();
    const maint = await getMaintenance();
    const embed = buildEmbed(results, uptime, maint);

    // work out the problem / resolved message without committing anything until it's actually posted
    const down = results.filter((r) => !r.ok).map((r) => r.name);
    let nextIncident = state.incident
      ? { started: state.incident.started, services: [...state.incident.services] }
      : null;
    let notice = null;

    if (maint.on) {
      // scheduled maintenance: no problem / resolved messages, the incident state stays as it was
    } else if (down.length) {
      if (!nextIncident) nextIncident = { started: Date.now(), services: [] };
      for (const name of down) if (!nextIncident.services.includes(name)) nextIncident.services.push(name);
      notice =
        `🔴 **Issue detected** — some systems are not responding\n` +
        `**Down:** ${down.join(', ')} · since <t:${Math.floor(nextIncident.started / 1000)}:R>`;
    } else if (nextIncident) {
      notice =
        `🟢 **Resolved** — everything is back up after ${formatDuration(Date.now() - nextIncident.started)}\n` +
        `**Was down:** ${nextIncident.services.join(', ')}`;
      nextIncident = null;
    }

    let channel;
    try {
      channel = await client.channels.fetch(STATUS_CHANNEL_ID);
      if (!channel || !channel.isTextBased()) throw new Error('not a text channel');
    } catch (err) {
      console.error('Status: cannot access the status channel:', err.message);
      return;
    }

    // post the new messages first (embed, then the notice below it), then delete the previous ones
    let newEmbed = null;
    let newNotice = null;
    try {
      newEmbed = await channel.send({ embeds: [embed] });
      if (notice) newNotice = await channel.send({ content: notice });
    } catch (err) {
      console.error('Status: could not post (check the bot can send messages + embed links there):', err.message);
      await deleteMessage(channel, newEmbed?.id);
      return;
    }

    const oldEmbedId = state.embedId;
    const oldNoticeId = state.noticeId;
    state.embedId = newEmbed.id;
    state.noticeId = newNotice ? newNotice.id : null;
    state.incident = nextIncident;

    await deleteMessage(channel, oldEmbedId);
    await deleteMessage(channel, oldNoticeId);
    await saveState();
  } catch (err) {
    console.error('Status cycle error:', err);
  } finally {
    running = false;
  }
}

function startStatusMonitor(client) {
  setTimeout(() => runCycle(client), 20_000); // first run shortly after the bot is ready
  setInterval(() => runCycle(client), INTERVAL_MS);
}

// Used by /status: current state of every system with 24h and 7d uptime from the stored history
async function getStatusSummary() {
  const maint = await getMaintenance();
  let latest = [];
  let windows = [];
  try {
    latest = (await pool.query(
      `SELECT DISTINCT ON (service) service, ok, latency_ms, checked_at
       FROM status_checks ORDER BY service, checked_at DESC`
    )).rows;
    windows = (await pool.query(
      `SELECT service,
              (COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '24 hours'))::int AS t24,
              (COUNT(*) FILTER (WHERE ok AND checked_at > NOW() - INTERVAL '24 hours'))::int AS u24,
              (COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '7 days'))::int AS t7,
              (COUNT(*) FILTER (WHERE ok AND checked_at > NOW() - INTERVAL '7 days'))::int AS u7
       FROM status_checks GROUP BY service`
    )).rows;
  } catch (err) {
    console.error('Status summary query failed:', err.message);
  }

  if (!latest.length) {
    return new EmbedBuilder()
      .setTitle('Ibuprofen Status')
      .setColor(0x5865F2)
      .setDescription('No data yet, the first check runs shortly after the bot starts.');
  }

  const byLatest = Object.fromEntries(latest.map((r) => [r.service, r]));
  const byWindow = Object.fromEntries(windows.map((r) => [r.service, r]));
  const pct = (up, total) => (total ? fmtPct((up / total) * 100) : 'n/a');

  const lines = [];
  let downCount = 0;
  for (const name of SERVICE_ORDER) {
    const l = byLatest[name];
    if (!l) continue;
    const w = byWindow[name] || { t24: 0, u24: 0, t7: 0, u7: 0 };
    if (!l.ok) downCount++;
    lines.push(
      `${l.ok ? '🟢' : '🔴'} **${name}** · 24h ${pct(w.u24, w.t24)} · 7d ${pct(w.u7, w.t7)} · ${l.ok ? `${l.latency_ms}ms` : 'Down'}`
    );
  }

  let label = 'Operational';
  let color = 0x2ecc71;
  if (maint.on) {
    label = 'Maintenance';
    color = 0x3498db;
  } else if (downCount === lines.length) {
    label = 'Major outage';
    color = 0xe74c3c;
  } else if (downCount) {
    label = 'Partial outage';
    color = 0xf39c12;
  }

  const header = maint.on
    ? `🔧 **Scheduled maintenance in progress**${maint.message ? `\n${maint.message}` : ''}\n\n`
    : '';
  const newest = latest.reduce((m, r) => Math.max(m, new Date(r.checked_at).getTime()), 0);

  return new EmbedBuilder()
    .setTitle(`Ibuprofen Status — ${label}`)
    .setDescription(header + lines.join('\n'))
    .setColor(color)
    .setFooter({ text: 'Last check' })
    .setTimestamp(new Date(newest));
}

// run a check cycle right now (used after /maintenance so the embed updates immediately)
const refreshStatus = (client) => runCycle(client);

module.exports = { startStatusMonitor, refreshStatus, getStatusSummary };
