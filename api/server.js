// api/server.js — the API your Roblox script calls
const crypto = require('crypto');
const express = require('express');
const { pool, initSchema } = require('../db');
const { logEvent, clean } = require('../log');

// used by the bot's status monitor; it never shows up in logs, stats or rate limits
const PROBE_KEY = '__status_probe__';

// ---- sharing detection (set these on the API service) ----
const SHARING_MAX_HWIDS = parseInt(process.env.SHARING_MAX_HWIDS, 10) || 3; // distinct HWIDs on one key within 24h
const SHARING_AUTOFREEZE = String(process.env.SHARING_AUTOFREEZE || '').toLowerCase() === 'true'; // false = just warn

const app = express();
app.set('trust proxy', 1); // Railway sits in front: use the real client IP
app.use(express.json({ limit: '10kb' }));

// ---------- rate limiting (per IP, in memory) ----------
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 30; // any request per minute
const FAIL_WINDOW_MS = 10 * 60_000;
const FAIL_MAX = 10; // wrong keys / wrong HWIDs per 10 minutes
const hits = new Map();
const fails = new Map();

function trim(list, windowMs, now) {
  while (list.length && now - list[0] > windowMs) list.shift();
}

function isRateLimited(ip) {
  const now = Date.now();
  const h = hits.get(ip) || [];
  const f = fails.get(ip) || [];
  trim(h, RATE_WINDOW_MS, now);
  trim(f, FAIL_WINDOW_MS, now);
  hits.set(ip, h);
  fails.set(ip, f);
  if (h.length >= RATE_MAX_REQUESTS || f.length >= FAIL_MAX) return true;
  h.push(now);
  return false;
}

function recordFailure(ip) {
  const f = fails.get(ip) || [];
  f.push(Date.now());
  fails.set(ip, f);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of fails) {
    trim(list, FAIL_WINDOW_MS, now);
    if (!list.length) fails.delete(ip);
  }
  for (const [ip, list] of hits) {
    trim(list, RATE_WINDOW_MS, now);
    if (!list.length) hits.delete(ip);
  }
}, 5 * 60_000).unref();

// short anonymous tag so logs can group requests without storing raw IPs
const ipTag = (ip) => crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 8);

// ---------- maintenance mode (set by the bot's /maintenance, cached for a few seconds) ----------
let maintenance = { on: false, message: '', fetchedAt: 0 };

async function getMaintenance() {
  const now = Date.now();
  if (now - maintenance.fetchedAt < 10_000) return maintenance;
  try {
    const { rows } = await pool.query(
      `SELECT k, v FROM bot_state WHERE k IN ('maintenance', 'maintenance_message')`
    );
    const map = Object.fromEntries(rows.map((r) => [r.k, r.v]));
    maintenance = { on: map.maintenance === 'on', message: map.maintenance_message || '', fetchedAt: now };
  } catch (err) {
    console.error('Could not read maintenance flag:', err.message);
    maintenance.fetchedAt = now; // keep the last known value
  }
  return maintenance;
}

// ---------- history ----------
// Unknown keys are stored without the key text so random input can't fill the table with junk keys
async function recordAttempt(keyValue, hwid, robloxName, result) {
  try {
    await pool.query(
      'INSERT INTO verify_log (key_value, hwid, roblox_name, result) VALUES ($1, $2, $3, $4)',
      [keyValue, String(hwid).slice(0, 128), robloxName, result]
    );
  } catch (err) {
    console.error('Could not record verify attempt:', err.message);
  }
}

async function isBanned(hwid, discordId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM blacklist
     WHERE (type = 'hwid' AND value = $1) OR (type = 'discord' AND value = $2) LIMIT 1`,
    [hwid, discordId || '']
  );
  return rows.length > 0;
}

// ---------- sharing alert ----------
const shareAlerted = new Map(); // key -> last alert time (one alert per key per 24h)

async function checkSharing(row) {
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT hwid)::int AS n FROM verify_log
     WHERE key_value = $1 AND created_at > NOW() - INTERVAL '24 hours'
       AND result IN ('valid', 'locked', 'hwid_mismatch')`,
    [row.key_value]
  );
  const n = rows[0].n;
  if (n < SHARING_MAX_HWIDS) return;

  const last = shareAlerted.get(row.key_value);
  if (last && Date.now() - last < 24 * 60 * 60 * 1000) return;
  shareAlerted.set(row.key_value, Date.now());

  let note = '';
  if (SHARING_AUTOFREEZE) {
    await pool.query('UPDATE keys SET frozen = TRUE WHERE id = $1', [row.id]);
    note = ' The key was **frozen automatically** (`/unfreeze` to restore it).';
  }
  logEvent(
    `**[SHARING ALERT]** key \`${row.key_value}\` was tried from **${n}** different HWIDs in 24h` +
    `${row.discord_id ? ` (owner <@${row.discord_id}>)` : ''}.${note}`
  );
}

app.get('/', (_req, res) => res.json({ status: 'up' }));
app.get('/health', (_req, res) => res.json({ status: 'up' }));

// POST /verify { key, hwid, name? }
app.post('/verify', async (req, res) => {
  try {
    const ip = req.ip;

    if (isRateLimited(ip)) {
      logEvent(`**[RATE LIMITED]** a client (ip tag \`${ipTag(ip)}\`) is sending too many /verify requests`, `rl:${ipTag(ip)}`);
      return res.status(429).json({ ok: false, reason: 'rate_limited' });
    }

    const { key, hwid, name } = req.body || {};
    if (typeof key !== 'string' || typeof hwid !== 'string' || !key || !hwid || key.length > 64 || hwid.length > 128) {
      return res.status(400).json({ ok: false, reason: 'missing_key_or_hwid' });
    }
    const robloxName = typeof name === 'string' && name ? clean(name, 40) : null;
    const isProbe = key === PROBE_KEY;

    const m = await getMaintenance();
    if (m.on) {
      return res.status(503).json({ ok: false, reason: 'maintenance', message: m.message || undefined });
    }

    const { rows } = await pool.query('SELECT * FROM keys WHERE key_value = $1', [key]);
    const row = rows[0];

    if (!row) {
      if (!isProbe) {
        recordFailure(ip);
        recordAttempt(null, hwid, robloxName, 'invalid_key');
        logEvent(
          `**[VERIFY FAILED]** invalid key \`${clean(key)}\` — hwid \`${clean(hwid)}\``,
          `invalid:${key}:${hwid}`
        );
      }
      return res.status(404).json({ ok: false, reason: 'invalid_key' });
    }

    if (await isBanned(hwid, row.discord_id)) {
      recordAttempt(row.key_value, hwid, robloxName, 'blacklisted');
      logEvent(
        `**[VERIFY BLOCKED]** blacklisted ${row.discord_id ? `account <@${row.discord_id}> or ` : ''}HWID — key \`${clean(key)}\`, hwid \`${clean(hwid)}\``,
        `ban:${key}:${hwid}`
      );
      return res.status(403).json({ ok: false, reason: 'blacklisted' });
    }

    if (row.frozen) {
      recordAttempt(row.key_value, hwid, robloxName, 'frozen');
      return res.status(403).json({ ok: false, reason: 'frozen' });
    }

    if (new Date(row.expires_at) < new Date()) {
      recordAttempt(row.key_value, hwid, robloxName, 'expired');
      logEvent(
        `**[VERIFY FAILED]** expired key \`${clean(key)}\` — hwid \`${clean(hwid)}\``,
        `expired:${key}:${hwid}`
      );
      return res.status(403).json({ ok: false, reason: 'expired' });
    }

    if (!row.hwid) {
      // First execution — lock the key to this hwid
      await pool.query('UPDATE keys SET hwid = $1 WHERE id = $2', [hwid, row.id]);
      recordAttempt(row.key_value, hwid, robloxName, 'locked');
      return res.json({ ok: true, reason: 'locked_to_hwid', expires_at: row.expires_at });
    }

    if (row.hwid !== hwid) {
      recordFailure(ip);
      await recordAttempt(row.key_value, hwid, robloxName, 'hwid_mismatch'); // awaited: the sharing check counts it
      logEvent(
        `**[VERIFY FAILED]** HWID mismatch on key \`${clean(key)}\` — attempted hwid \`${clean(hwid)}\``,
        `mismatch:${key}:${hwid}`
      );
      try {
        await checkSharing(row);
      } catch (err) {
        console.error('Sharing check failed:', err.message);
      }
      return res.status(403).json({ ok: false, reason: 'hwid_mismatch' });
    }

    recordAttempt(row.key_value, hwid, robloxName, 'valid');
    return res.json({ ok: true, reason: 'valid', expires_at: row.expires_at });
  } catch (err) {
    console.error('Error in /verify:', err);
    return res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

// malformed JSON and the like
app.use((err, _req, res, _next) => {
  res.status(400).json({ ok: false, reason: 'bad_request' });
});

const PORT = process.env.PORT || 3000;
initSchema()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`API listening on ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to init schema:', err);
    process.exit(1);
  });
