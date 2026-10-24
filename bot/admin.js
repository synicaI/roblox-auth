// bot/admin.js — admin slash commands (guild-only, same role + channel restriction as the other admin commands):
// /checkkey /lookup /userkey /extend /unlink /freeze /unfreeze /history /blacklist /mediaban /maintenance /serverstats
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const unix = (d) => Math.floor(new Date(d).getTime() / 1000);
const DAY_MS = 86_400_000;

function createAdmin({ pool, logEvent, addLicenseRole, removeLicenseRole, hasActiveKey, refreshStatus }) {
  const keyOption = (o) => o.setName('key').setDescription('The key').setRequired(true);
  const userOption = (o) => o.setName('user').setDescription('The member').setRequired(true);

  const builders = [
    new SlashCommandBuilder()
      .setName('checkkey')
      .setDescription('Show the details of one key')
      .addStringOption(keyOption),
    new SlashCommandBuilder()
      .setName('lookup')
      .setDescription('Find the keys linked to a Discord account')
      .addUserOption(userOption),
    new SlashCommandBuilder()
      .setName('userkey')
      .setDescription('Same as /lookup: find the keys linked to a Discord account')
      .addUserOption(userOption),
    new SlashCommandBuilder()
      .setName('extend')
      .setDescription('Add days to a key without resetting its HWID')
      .addStringOption(keyOption)
      .addIntegerOption(o => o.setName('days').setDescription('Days to add').setRequired(true).setMinValue(1)),
    new SlashCommandBuilder()
      .setName('unlink')
      .setDescription('Detach a key from its Discord owner and remove their role')
      .addStringOption(keyOption),
    new SlashCommandBuilder()
      .setName('freeze')
      .setDescription('Suspend a key: /verify refuses it until /unfreeze')
      .addStringOption(keyOption),
    new SlashCommandBuilder()
      .setName('unfreeze')
      .setDescription('Restore a frozen key')
      .addStringOption(keyOption),
    new SlashCommandBuilder()
      .setName('history')
      .setDescription('Recent executions of a key (date, HWID, Roblox name)')
      .addStringOption(keyOption),
    new SlashCommandBuilder()
      .setName('blacklist')
      .setDescription('Ban an HWID or a Discord account')
      .addSubcommand(s => s
        .setName('add').setDescription('Add a ban')
        .addStringOption(o => o.setName('hwid').setDescription('HWID to ban'))
        .addUserOption(o => o.setName('user').setDescription('Discord account to ban'))
        .addStringOption(o => o.setName('reason').setDescription('Reason')))
      .addSubcommand(s => s
        .setName('remove').setDescription('Remove a ban')
        .addStringOption(o => o.setName('hwid').setDescription('HWID to unban'))
        .addUserOption(o => o.setName('user').setDescription('Discord account to unban')))
      .addSubcommand(s => s.setName('list').setDescription('Show all bans')),
    new SlashCommandBuilder()
      .setName('mediaban')
      .setDescription('Ban a member from using /media')
      .addSubcommand(s => s
        .setName('add').setDescription('Ban a member from /media')
        .addUserOption(userOption)
        .addStringOption(o => o.setName('reason').setDescription('Reason')))
      .addSubcommand(s => s
        .setName('remove').setDescription('Lift a /media ban')
        .addUserOption(userOption))
      .addSubcommand(s => s.setName('list').setDescription('Show members banned from /media')),
    new SlashCommandBuilder()
      .setName('maintenance')
      .setDescription('Turn maintenance mode on or off')
      .addStringOption(o => o
        .setName('state').setDescription('on or off').setRequired(true)
        .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
      .addStringOption(o => o
        .setName('message').setDescription('Message shown to users in the loader (optional)').setMaxLength(200)),
    new SlashCommandBuilder()
      .setName('serverstats')
      .setDescription('Key and usage statistics'),
  ];

  // ---------- helpers ----------

  const notFound = (interaction) => interaction.reply({ content: 'Key not found.', ephemeral: true });

  // Sends a list as one or more messages (Discord caps a message at 2000 characters)
  async function replyLines(interaction, lines, emptyText) {
    if (!lines.length) return interaction.reply({ content: emptyText, ephemeral: true });
    const chunks = [];
    let current = '';
    for (const line of lines) {
      if ((current + '\n' + line).length > 1900) {
        chunks.push(current);
        current = line;
      } else {
        current = current ? current + '\n' + line : line;
      }
    }
    if (current) chunks.push(current);
    await interaction.reply({ content: chunks[0], ephemeral: true });
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i], ephemeral: true });
    }
  }

  const upsertBan = (type, value, reason, by) =>
    pool.query(
      `INSERT INTO blacklist (type, value, reason, added_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (type, value) DO UPDATE SET reason = EXCLUDED.reason, added_by = EXCLUDED.added_by`,
      [type, value, reason, by]
    );

  const removeBan = (type, value) =>
    pool.query('DELETE FROM blacklist WHERE type = $1 AND value = $2', [type, value]);

  const setState = (k, v) =>
    pool.query(
      'INSERT INTO bot_state (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v',
      [k, v]
    );

  const statusOf = (r) => {
    if (r.frozen) return 'Frozen';
    return new Date(r.expires_at) < new Date() ? 'Expired' : 'Active';
  };

  function timeLeft(expiresAt) {
    const ms = new Date(expiresAt) - Date.now();
    if (ms > 0) {
      const days = Math.ceil(ms / DAY_MS);
      return `${days} day${days > 1 ? 's' : ''} left`;
    }
    const ago = Math.floor(-ms / DAY_MS);
    return ago < 1 ? 'expired today' : `expired ${ago} day${ago > 1 ? 's' : ''} ago`;
  }

  // ---------- commands ----------

  const handlers = {
    async checkkey(interaction) {
      const key = interaction.options.getString('key');
      const { rows } = await pool.query(
        `SELECT k.*,
                (SELECT MAX(v.created_at) FROM verify_log v
                 WHERE v.key_value = k.key_value AND v.result IN ('valid', 'locked')) AS last_seen
         FROM keys k WHERE k.key_value = $1`,
        [key]
      );
      const r = rows[0];
      if (!r) return notFound(interaction);

      const embed = new EmbedBuilder()
        .setTitle('Key details')
        .setColor(r.frozen ? 0xe74c3c : 0x5865F2)
        .addFields(
          { name: 'Key', value: `\`${r.key_value}\``, inline: true },
          { name: 'Status', value: statusOf(r), inline: true },
          { name: 'Owner', value: r.discord_id ? `<@${r.discord_id}>` : 'Unclaimed', inline: true },
          { name: 'Expires', value: `<t:${unix(r.expires_at)}:F> (${timeLeft(r.expires_at)})` },
          { name: 'HWID', value: r.hwid ? `\`${r.hwid}\`` : 'Not locked yet' },
          { name: 'Last HWID reset', value: r.last_hwid_reset ? `<t:${unix(r.last_hwid_reset)}:R>` : 'Never', inline: true },
          { name: 'Claimed', value: r.claimed_at ? `<t:${unix(r.claimed_at)}:R>` : '—', inline: true },
          { name: 'Last execution', value: r.last_seen ? `<t:${unix(r.last_seen)}:R>` : 'Never', inline: true },
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    },

    async lookup(interaction) {
      const user = interaction.options.getUser('user');
      const { rows } = await pool.query(
        `SELECT key_value, hwid, expires_at, frozen, last_hwid_reset
         FROM keys WHERE discord_id = $1 ORDER BY expires_at DESC LIMIT 10`,
        [user.id]
      );
      const { rows: bans } = await pool.query(
        `SELECT type FROM blacklist WHERE type IN ('discord', 'media') AND value = $1`,
        [user.id]
      );
      const banned = bans.some((b) => b.type === 'discord');
      const mediaBanned = bans.some((b) => b.type === 'media');

      const embed = new EmbedBuilder()
        .setTitle(`Keys of ${user.username}`)
        .setColor(0x5865F2)
        .setDescription(rows.length ? `${rows.length} key${rows.length > 1 ? 's' : ''} linked to <@${user.id}>` : `No key is linked to <@${user.id}>.`);
      for (const r of rows) {
        embed.addFields({
          name: statusOf(r),
          value:
            `Key: \`${r.key_value}\`\n` +
            `Expires: <t:${unix(r.expires_at)}:F> (${timeLeft(r.expires_at)})\n` +
            `HWID: ${r.hwid ? `\`${r.hwid}\`` : 'Not locked yet'}\n` +
            `Last reset: ${r.last_hwid_reset ? `<t:${unix(r.last_hwid_reset)}:R>` : 'Never'}`,
        });
      }
      embed.addFields({
        name: 'Bans',
        value: `Blacklisted: **${banned ? 'yes' : 'no'}** · Banned from /media: **${mediaBanned ? 'yes' : 'no'}**`,
      });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    },

    async extend(interaction) {
      const key = interaction.options.getString('key');
      const days = interaction.options.getInteger('days');
      // counts from the current expiry, or from now when the key already expired; the HWID is left alone
      const { rows } = await pool.query(
        `UPDATE keys
         SET expires_at = GREATEST(expires_at, NOW()::timestamp) + ($1 || ' days')::interval,
             reminder_sent = FALSE, role_removed = FALSE
         WHERE key_value = $2
         RETURNING discord_id, expires_at, frozen`,
        [String(days), key]
      );
      if (!rows.length) return notFound(interaction);

      const r = rows[0];
      let note = '';
      if (r.discord_id && !r.frozen && (await addLicenseRole(r.discord_id))) note = ' Owner\'s role restored.';
      logEvent(`**[KEY EXTENDED]** \`${key}\` +${days} days by <@${interaction.user.id}>`);
      return interaction.reply({
        content: `Key \`${key}\` extended by ${days} days, it now expires <t:${unix(r.expires_at)}:F> (<t:${unix(r.expires_at)}:R>). HWID unchanged.${note}`,
        ephemeral: true,
      });
    },

    async unlink(interaction) {
      const key = interaction.options.getString('key');
      const { rows } = await pool.query('SELECT id, discord_id FROM keys WHERE key_value = $1', [key]);
      if (!rows.length) return notFound(interaction);

      const owner = rows[0].discord_id;
      if (!owner) return interaction.reply({ content: 'This key is not linked to anyone.', ephemeral: true });

      await pool.query(
        'UPDATE keys SET discord_id = NULL, claimed_at = NULL, role_removed = FALSE WHERE id = $1',
        [rows[0].id]
      );
      let note = '';
      if (!(await hasActiveKey(owner)) && (await removeLicenseRole(owner))) note = ' Their role was removed.';
      logEvent(`**[KEY UNLINKED]** \`${key}\` detached from <@${owner}> by <@${interaction.user.id}>`);
      return interaction.reply({ content: `Key \`${key}\` detached from <@${owner}>.${note}`, ephemeral: true });
    },

    async freeze(interaction) {
      const key = interaction.options.getString('key');
      const { rows } = await pool.query(
        'UPDATE keys SET frozen = TRUE WHERE key_value = $1 RETURNING discord_id', [key]
      );
      if (!rows.length) return notFound(interaction);

      const owner = rows[0].discord_id;
      let note = '';
      if (owner && !(await hasActiveKey(owner)) && (await removeLicenseRole(owner))) note = ' Owner\'s role removed.';
      logEvent(`**[KEY FROZEN]** \`${key}\` by <@${interaction.user.id}>`);
      return interaction.reply({ content: `Key \`${key}\` is frozen: /verify now refuses it.${note}`, ephemeral: true });
    },

    async unfreeze(interaction) {
      const key = interaction.options.getString('key');
      const { rows } = await pool.query(
        'UPDATE keys SET frozen = FALSE, role_removed = FALSE WHERE key_value = $1 RETURNING discord_id, expires_at',
        [key]
      );
      if (!rows.length) return notFound(interaction);

      const r = rows[0];
      let note = '';
      if (r.discord_id && new Date(r.expires_at) > new Date() && (await addLicenseRole(r.discord_id))) {
        note = ' Owner\'s role restored.';
      }
      logEvent(`**[KEY UNFROZEN]** \`${key}\` by <@${interaction.user.id}>`);
      return interaction.reply({ content: `Key \`${key}\` restored.${note}`, ephemeral: true });
    },

    async history(interaction) {
      const key = interaction.options.getString('key');
      const { rows: found } = await pool.query('SELECT 1 FROM keys WHERE key_value = $1', [key]);
      if (!found.length) return notFound(interaction);

      const { rows } = await pool.query(
        `SELECT hwid, roblox_name, result, created_at FROM verify_log
         WHERE key_value = $1 ORDER BY created_at DESC LIMIT 15`,
        [key]
      );
      const labels = {
        valid: '✅ ok',
        locked: '✅ first run (HWID locked)',
        hwid_mismatch: '❌ HWID mismatch',
        expired: '❌ expired',
        frozen: '❌ frozen',
        blacklisted: '❌ blacklisted',
      };
      const lines = rows.map(
        (r) => `<t:${unix(r.created_at)}:R> · \`${r.hwid}\` · ${r.roblox_name || 'unknown'} · ${labels[r.result] || r.result}`
      );
      const embed = new EmbedBuilder()
        .setTitle('Recent executions')
        .setColor(0x5865F2)
        .setDescription(lines.length ? `Key \`${key}\`, last ${lines.length}:\n\n${lines.join('\n')}` : `No execution recorded yet for \`${key}\`.`);
      return interaction.reply({ embeds: [embed], ephemeral: true });
    },

    async blacklist(interaction) {
      const sub = interaction.options.getSubcommand();
      const by = interaction.user.id;

      if (sub === 'list') {
        const { rows } = await pool.query(
          `SELECT type, value, reason, created_at FROM blacklist
           WHERE type IN ('hwid', 'discord') ORDER BY created_at DESC LIMIT 100`
        );
        const lines = rows.map(
          (r) =>
            `${r.type === 'hwid' ? `HWID \`${r.value}\`` : `User <@${r.value}>`}` +
            `${r.reason ? ` — ${r.reason}` : ''} (<t:${unix(r.created_at)}:d>)`
        );
        return replyLines(interaction, lines, 'The blacklist is empty.');
      }

      const hwid = (interaction.options.getString('hwid') || '').trim() || null;
      const user = interaction.options.getUser('user');
      if (!hwid && !user) {
        return interaction.reply({ content: 'Give an HWID and/or a user.', ephemeral: true });
      }

      if (sub === 'add') {
        const reason = interaction.options.getString('reason') || null;
        const done = [];
        if (hwid) {
          await upsertBan('hwid', hwid, reason, by);
          done.push(`HWID \`${hwid}\``);
        }
        if (user) {
          await upsertBan('discord', user.id, reason, by);
          await removeLicenseRole(user.id);
          done.push(`<@${user.id}>`);
        }
        logEvent(`**[BLACKLIST ADD]** ${done.join(', ')} by <@${by}>${reason ? ` — ${reason}` : ''}`);
        return interaction.reply({ content: `Blacklisted: ${done.join(', ')}. Their keys are refused by /verify and their bot commands stop working.`, ephemeral: true });
      }

      // remove
      const done = [];
      if (hwid) {
        await removeBan('hwid', hwid);
        done.push(`HWID \`${hwid}\``);
      }
      if (user) {
        await removeBan('discord', user.id);
        if (await hasActiveKey(user.id)) await addLicenseRole(user.id);
        done.push(`<@${user.id}>`);
      }
      logEvent(`**[BLACKLIST REMOVE]** ${done.join(', ')} by <@${by}>`);
      return interaction.reply({ content: `Removed from the blacklist: ${done.join(', ')}.`, ephemeral: true });
    },

    async mediaban(interaction) {
      const sub = interaction.options.getSubcommand();
      const by = interaction.user.id;

      if (sub === 'list') {
        const { rows } = await pool.query(
          `SELECT value, reason, created_at FROM blacklist WHERE type = 'media' ORDER BY created_at DESC LIMIT 100`
        );
        const lines = rows.map((r) => `<@${r.value}>${r.reason ? ` — ${r.reason}` : ''} (<t:${unix(r.created_at)}:d>)`);
        return replyLines(interaction, lines, 'Nobody is banned from /media.');
      }

      const user = interaction.options.getUser('user');
      if (sub === 'add') {
        const reason = interaction.options.getString('reason') || null;
        await upsertBan('media', user.id, reason, by);
        logEvent(`**[MEDIA BAN]** <@${user.id}> banned from /media by <@${by}>${reason ? ` — ${reason}` : ''}`);
        return interaction.reply({ content: `<@${user.id}> can no longer use /media.`, ephemeral: true });
      }

      await removeBan('media', user.id);
      logEvent(`**[MEDIA UNBAN]** <@${user.id}> can use /media again (by <@${by}>)`);
      return interaction.reply({ content: `<@${user.id}> can use /media again.`, ephemeral: true });
    },

    async maintenance(interaction) {
      const state = interaction.options.getString('state');
      const message = (interaction.options.getString('message') || '').trim();

      await setState('maintenance', state);
      await setState('maintenance_message', state === 'on' ? message : '');
      logEvent(`**[MAINTENANCE ${state.toUpperCase()}]** by <@${interaction.user.id}>${state === 'on' && message ? ` — ${message}` : ''}`);

      // update the status embed right away instead of waiting for the next 15-minute check
      if (refreshStatus) refreshStatus().catch((err) => console.error('Status refresh failed:', err.message));

      return interaction.reply({
        content:
          state === 'on'
            ? 'Maintenance mode is **ON**: /verify answers "maintenance" (it can take up to 10 seconds to apply) and the status embed shows Maintenance. The loader shows a message instead of kicking.'
            : 'Maintenance mode is **OFF**: /verify is back to normal.',
        ephemeral: true,
      });
    },

    async serverstats(interaction) {
      const { rows: [k] } = await pool.query(
        `SELECT COUNT(*)::int AS total,
                (COUNT(*) FILTER (WHERE expires_at > NOW() AND NOT frozen))::int AS active,
                (COUNT(*) FILTER (WHERE expires_at <= NOW()))::int AS expired,
                (COUNT(*) FILTER (WHERE expires_at > NOW() AND discord_id IS NULL))::int AS unclaimed,
                (COUNT(*) FILTER (WHERE frozen))::int AS frozen,
                (COUNT(*) FILTER (WHERE hwid IS NOT NULL AND expires_at > NOW()))::int AS locked
         FROM keys`
      );
      const { rows: [d] } = await pool.query(
        `SELECT (SELECT COUNT(*) FROM keys WHERE claimed_at > NOW() - INTERVAL '24 hours')::int AS redeems,
                (SELECT COUNT(*) FROM verify_log WHERE created_at > NOW() - INTERVAL '24 hours' AND result IN ('valid', 'locked'))::int AS ok,
                (SELECT COUNT(*) FROM verify_log WHERE created_at > NOW() - INTERVAL '24 hours' AND result NOT IN ('valid', 'locked'))::int AS bad`
      );
      const { rows: redeemRows } = await pool.query(
        `SELECT to_char(claimed_at, 'YYYY-MM-DD') AS d, COUNT(*)::int AS n
         FROM keys WHERE claimed_at > NOW() - INTERVAL '7 days' GROUP BY 1`
      );
      const { rows: verifyRows } = await pool.query(
        `SELECT to_char(created_at, 'YYYY-MM-DD') AS d,
                (COUNT(*) FILTER (WHERE result IN ('valid', 'locked')))::int AS ok,
                (COUNT(*) FILTER (WHERE result NOT IN ('valid', 'locked')))::int AS bad
         FROM verify_log WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY 1`
      );
      const { rows: banRows } = await pool.query('SELECT type, COUNT(*)::int AS n FROM blacklist GROUP BY type');
      const { rows: stateRows } = await pool.query(`SELECT v FROM bot_state WHERE k = 'maintenance'`);

      const bans = Object.fromEntries(banRows.map((b) => [b.type, b.n]));
      const maintenanceOn = stateRows[0] && stateRows[0].v === 'on';

      // last 7 days, oldest first
      const redeemByDay = Object.fromEntries(redeemRows.map((r) => [r.d, r.n]));
      const verifyByDay = Object.fromEntries(verifyRows.map((r) => [r.d, r]));
      const table = [];
      for (let i = 6; i >= 0; i--) {
        const day = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
        const v = verifyByDay[day] || { ok: 0, bad: 0 };
        table.push(
          `${day}  ${String(redeemByDay[day] || 0).padStart(6)}  ${String(v.ok).padStart(9)}  ${String(v.bad).padStart(6)}`
        );
      }

      const embed = new EmbedBuilder()
        .setTitle('Server stats')
        .setColor(0x5865F2)
        .addFields(
          {
            name: `Keys (${k.total})`,
            value:
              `Active **${k.active}** · Expired **${k.expired}** · Unclaimed **${k.unclaimed}**\n` +
              `Frozen **${k.frozen}** · HWID locked **${k.locked}**`,
          },
          {
            name: 'Last 24 hours',
            value: `Redeems **${d.redeems}** · Verifies ok **${d.ok}** · Verifies failed **${d.bad}**`,
          },
          {
            name: 'Bans',
            value: `HWIDs **${bans.hwid || 0}** · Accounts **${bans.discord || 0}** · /media **${bans.media || 0}**`,
            inline: true,
          },
          { name: 'Maintenance', value: maintenanceOn ? 'ON' : 'off', inline: true },
          {
            name: 'Last 7 days',
            value: '```\nDate        Redeem  Verify OK  Failed\n' + table.join('\n') + '\n```',
          },
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    },
  };
  handlers.userkey = handlers.lookup;

  // Returns true when the command belongs to this module (and has been handled)
  async function handle(interaction) {
    const fn = handlers[interaction.commandName];
    if (!fn) return false;
    await fn(interaction);
    return true;
  }

  return { builders, handle };
}

module.exports = { createAdmin };
