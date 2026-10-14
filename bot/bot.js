// bot/bot.js — key management, license panel, hourly maintenance, event logs
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  AttachmentBuilder, EmbedBuilder,
} = require('discord.js');
const crypto = require('crypto');
const path = require('path');
const { pool, initSchema } = require('../db');
const { logEvent } = require('../log');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const ALLOWED_ROLE_ID = process.env.ALLOWED_ROLE_ID;       // role permitted to run admin commands
const ALLOWED_CHANNEL_ID = process.env.ALLOWED_CHANNEL_ID; // channel admin commands work in
const LICENSE_ROLE_ID = process.env.LICENSE_ROLE_ID;       // role granted once a valid key is entered
const SCRIPT_FILE_PATH = process.env.SCRIPT_FILE_PATH || path.join(__dirname, '..', 'assets', 'script.lua');
const RESET_COOLDOWN_DAYS = parseInt(process.env.HWID_RESET_COOLDOWN_DAYS, 10) || 7; // self-service HWID reset cooldown
const RENEW_URL = process.env.RENEW_URL || '';             // optional link shown in expiry reminder DMs
const REMINDER_DAYS = 3;
const SERVER_INVITE = process.env.SERVER_INVITE || 'https://discord.gg/uTEs99V6qE';
const NEED_KEY_MSG = 'You need an active key to use this. Use **/redeem** to link one.';
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;            // hourly

const unix = (d) => Math.floor(new Date(d).getTime() / 1000);

const adminCommands = [
  new SlashCommandBuilder()
    .setName('addkey')
    .setDescription('Generate a new license key')
    .addIntegerOption(o => o.setName('duration').setDescription('Duration in days').setRequired(true)),
  new SlashCommandBuilder()
    .setName('setduration')
    .setDescription('Change a key\'s duration (also resets its HWID lock)')
    .addStringOption(o => o.setName('key').setDescription('The key').setRequired(true))
    .addIntegerOption(o => o.setName('days').setDescription('New duration in days from now').setRequired(true)),
  new SlashCommandBuilder()
    .setName('resethwid')
    .setDescription('Manually reset a key\'s HWID lock')
    .addStringOption(o => o.setName('key').setDescription('The key').setRequired(true)),
  new SlashCommandBuilder()
    .setName('revokekey')
    .setDescription('Delete a key')
    .addStringOption(o => o.setName('key').setDescription('The key').setRequired(true)),
  new SlashCommandBuilder()
    .setName('listkeys')
    .setDescription('List all keys and the HWID they are locked to'),
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Post the license button panel in this channel'),
].map(c => c.toJSON());

// Commands usable anywhere (servers, DMs, group DMs) once the app is installed on a user's account.
// integration_types: 0 = guild install, 1 = user install | contexts: 0 = guild, 1 = bot DM, 2 = other DMs/group DMs
const userCommandBuilders = [
  new SlashCommandBuilder()
    .setName('public')
    .setDescription('Choose if the bot replies only to you or in public chat')
    .addBooleanOption(o => o.setName('enabled').setDescription('true = everyone can see replies, false = only you').setRequired(true)),
  new SlashCommandBuilder()
    .setName('redeem')
    .setDescription('Redeem your license key to whitelist your Discord account'),
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show your license stats'),
  new SlashCommandBuilder()
    .setName('information')
    .setDescription('FAQ and pricing'),
  new SlashCommandBuilder()
    .setName('script')
    .setDescription('Get the script (requires an active key)'),
  new SlashCommandBuilder()
    .setName('hwid-reset')
    .setDescription('Reset your HWID (cooldown applies)'),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Get the support server invite'),
];
const userCommands = userCommandBuilders.map(c => ({
  ...c.toJSON(),
  integration_types: [0, 1],
  contexts: [0, 1, 2],
}));
const USER_COMMAND_NAMES = new Set(userCommandBuilders.map(c => c.name));

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  // admin commands stay private to your server
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: adminCommands });
  // user commands are global so they work everywhere
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: userCommands });
  console.log('Slash commands registered.');
}

function genKey() {
  return crypto.randomBytes(12).toString('hex'); // 24-char key
}

function isAllowed(interaction) {
  if (interaction.channelId !== ALLOWED_CHANNEL_ID) return false;
  return interaction.member.roles.cache.has(ALLOWED_ROLE_ID);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function safeReply(interaction, payload) {
  try {
    if (interaction.replied || interaction.deferred) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch (err) {
    console.error('Reply failed:', err.message);
  }
}

// ---------- role helpers ----------

async function addLicenseRole(userId) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(userId);
    await member.roles.add(LICENSE_ROLE_ID);
    return true;
  } catch (err) {
    console.error('Could not add role:', err.message);
    return false;
  }
}

async function removeLicenseRole(userId) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(userId);
    if (member.roles.cache.has(LICENSE_ROLE_ID)) await member.roles.remove(LICENSE_ROLE_ID);
    return true;
  } catch (err) {
    if (err.code === 10007) return true; // member left the server, nothing to remove
    console.error('Could not remove role:', err.message);
    return false;
  }
}

async function hasActiveKey(discordId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM keys WHERE discord_id = $1 AND expires_at > NOW() LIMIT 1',
    [discordId]
  );
  return rows.length > 0;
}

// ---------- shared key logic (used by the panel and the user commands) ----------

// Validates a key and links it to a Discord account (atomic, so two people can't claim it at once)
async function claimKey(userId, key) {
  const { rows } = await pool.query('SELECT * FROM keys WHERE key_value = $1', [key]);
  const row = rows[0];

  if (!row) return { ok: false, message: 'Invalid key.' };
  if (new Date(row.expires_at) < new Date()) return { ok: false, message: 'This key has expired.' };
  if (row.discord_id && row.discord_id !== userId) {
    return { ok: false, message: 'This key is already linked to another Discord account.' };
  }

  const firstClaim = !row.discord_id;
  if (firstClaim) {
    const result = await pool.query(
      'UPDATE keys SET discord_id = $1 WHERE id = $2 AND discord_id IS NULL',
      [userId, row.id]
    );
    if (!result.rowCount) {
      return { ok: false, message: 'This key is already linked to another Discord account.' };
    }
  }
  return { ok: true, firstClaim, row };
}

// The account's active (non-expired) key with the latest expiry, plus HWID-reset availability
async function getActiveKey(userId) {
  const { rows } = await pool.query(
    `SELECT id, key_value, hwid, expires_at,
            (last_hwid_reset IS NULL OR last_hwid_reset + ($2 || ' days')::interval <= NOW()) AS can_reset,
            last_hwid_reset + ($2 || ' days')::interval AS available_at
     FROM keys
     WHERE discord_id = $1 AND expires_at > NOW()
     ORDER BY expires_at DESC LIMIT 1`,
    [userId, String(RESET_COOLDOWN_DAYS)]
  );
  return rows[0] || null;
}

async function selfResetHwid(userId) {
  const row = await getActiveKey(userId);
  if (!row) return { ok: false, content: NEED_KEY_MSG };
  if (!row.hwid) return { ok: false, content: 'Your HWID is not locked yet, there is nothing to reset.' };
  if (!row.can_reset) {
    return { ok: false, content: `You can reset your HWID again <t:${unix(row.available_at)}:R>.` };
  }

  // atomic update so a double click can't bypass the cooldown
  const result = await pool.query(
    `UPDATE keys SET hwid = NULL, last_hwid_reset = NOW()
     WHERE id = $1 AND hwid IS NOT NULL
       AND (last_hwid_reset IS NULL OR last_hwid_reset + ($2 || ' days')::interval <= NOW())`,
    [row.id, String(RESET_COOLDOWN_DAYS)]
  );
  if (!result.rowCount) return { ok: false, content: 'Reset is not available right now.' };

  logEvent(`**[HWID RESET]** <@${userId}> reset their own HWID — key \`${row.key_value}\``);
  return {
    ok: true,
    content: `Your HWID has been reset. You can do this again in ${RESET_COOLDOWN_DAYS} days. Run the script to lock it to your new device.`,
  };
}

// ---------- user commands (work everywhere the app is installed) ----------

// Per-user "public" setting: private (ephemeral) by default
async function visibility(userId) {
  const { rows } = await pool.query('SELECT public_replies FROM user_settings WHERE discord_id = $1', [userId]);
  return rows[0]?.public_replies ? {} : { ephemeral: true };
}

const maskKey = (k) => `${k.slice(0, 4)}…${k.slice(-4)}`;

function buildInfoEmbed() {
  return new EmbedBuilder()
    .setTitle('FAQ')
    .setColor(0x5865F2)
    .setDescription(
      'Ibuprofen is a Roblox Luau script made for closet cheating. It supports multiple Da Hood remakes, such as Voidfalls\' games, Hood Customs, Dee Hood, Dea Hood and Hood Modded.\n\n' +
      'To protect your private data, Ibuprofen only stores your HWID, your license key and the Discord account linked to it, which is used to prevent key sharing.\n\n' +
      'Ibuprofen works with most executors, but some may crash on the first execution.'
    )
    .addFields(
      { name: 'Pricing', value: '• 7-Day License — €1\n• 30-Day License — €2\n• Lifetime License — €3' },
      { name: 'More questions?', value: 'Make a ticket in our Discord server. Use **/help** to get the invite.' },
    );
}

async function handleUserCommand(interaction) {
  const userId = interaction.user.id;
  const name = interaction.commandName;

  try {
    // Open to everyone
    if (name === 'redeem') {
      // A modal (instead of a command option) so the key is never shown in chat
      const modal = new ModalBuilder().setCustomId('redeem_modal').setTitle('Redeem your license key');
      const keyInput = new TextInputBuilder()
        .setCustomId('key_input')
        .setLabel('License key')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
      return await interaction.showModal(modal);
    }

    if (name === 'public') {
      const enabled = interaction.options.getBoolean('enabled');
      await pool.query(
        `INSERT INTO user_settings (discord_id, public_replies) VALUES ($1, $2)
         ON CONFLICT (discord_id) DO UPDATE SET public_replies = EXCLUDED.public_replies`,
        [userId, enabled]
      );
      return interaction.reply({
        content: enabled
          ? 'Public replies enabled: my replies will be visible to everyone in the chat. `/script` and `/redeem` always stay private.'
          : 'Public replies disabled: only you can see my replies.',
        ephemeral: true,
      });
    }

    if (name === 'information') {
      return interaction.reply({ embeds: [buildInfoEmbed()], ...(await visibility(userId)) });
    }

    if (name === 'help') {
      return interaction.reply({ content: `Need help? Join the server and make a ticket: ${SERVER_INVITE}`, ...(await visibility(userId)) });
    }

    // Everything below needs an active key linked to this account (revoked/expired => blocked until a new redeem)
    const key = await getActiveKey(userId);
    if (!key) return interaction.reply({ content: NEED_KEY_MSG, ephemeral: true });

    if (name === 'script') {
      // always private: a public reply would let everyone in the channel download the script
      const attachment = new AttachmentBuilder(SCRIPT_FILE_PATH);
      return interaction.reply({ content: 'Here is your script:', files: [attachment], ephemeral: true });
    }

    if (name === 'hwid-reset') {
      const result = await selfResetHwid(userId);
      return interaction.reply({ content: result.content, ...(await visibility(userId)) });
    }

    if (name === 'stats') {
      let resetText = 'Available now';
      if (!key.hwid) resetText = 'Nothing to reset';
      else if (!key.can_reset) resetText = `Available <t:${unix(key.available_at)}:R>`;

      const embed = new EmbedBuilder()
        .setTitle('Your stats')
        .setColor(0x5865F2)
        .addFields(
          // key is masked and HWID never shown, since replies can be public
          { name: 'Key', value: `\`${maskKey(key.key_value)}\``, inline: true },
          { name: 'Status', value: 'Active', inline: true },
          { name: 'Expires', value: `<t:${unix(key.expires_at)}:F> (<t:${unix(key.expires_at)}:R>)` },
          { name: 'HWID', value: key.hwid ? 'Locked' : 'Not locked yet', inline: true },
          { name: 'HWID reset', value: resetText, inline: true },
        );
      return interaction.reply({ embeds: [embed], ...(await visibility(userId)) });
    }
  } catch (err) {
    console.error('User command error:', err);
    return safeReply(interaction, { content: 'Something went wrong. Contact an admin.', ephemeral: true });
  }
}

// ---------- hourly maintenance: expiry role removal + reminders ----------

async function runMaintenance() {
  try {
    // 1. Remove the license role from owners whose key(s) have all expired
    const { rows: expired } = await pool.query(
      `SELECT id, key_value, discord_id FROM keys
       WHERE discord_id IS NOT NULL AND role_removed = FALSE AND expires_at < NOW()`
    );
    for (const row of expired) {
      if (!(await hasActiveKey(row.discord_id))) {
        const ok = await removeLicenseRole(row.discord_id);
        if (!ok) continue; // retry next run
        logEvent(`**[ROLE REMOVED]** <@${row.discord_id}> — key \`${row.key_value}\` expired`);
      }
      await pool.query('UPDATE keys SET role_removed = TRUE WHERE id = $1', [row.id]);
    }

    // 2. DM a reminder shortly before expiry
    const { rows: soon } = await pool.query(
      `SELECT id, key_value, discord_id, expires_at FROM keys
       WHERE discord_id IS NOT NULL AND reminder_sent = FALSE
         AND expires_at > NOW() AND expires_at <= NOW() + ($1 || ' days')::interval`,
      [String(REMINDER_DAYS)]
    );
    for (const row of soon) {
      // mark first so a failing DM is never retried every hour
      await pool.query('UPDATE keys SET reminder_sent = TRUE WHERE id = $1', [row.id]);
      try {
        const user = await client.users.fetch(row.discord_id);
        const renew = RENEW_URL ? `Renew here: ${RENEW_URL}` : 'Contact an admin to renew it.';
        await user.send(
          `Your license expires <t:${unix(row.expires_at)}:R> (<t:${unix(row.expires_at)}:F>). ${renew}`
        );
        logEvent(`**[REMINDER SENT]** <@${row.discord_id}> — key \`${row.key_value}\``);
      } catch (err) {
        logEvent(`**[REMINDER FAILED]** could not DM <@${row.discord_id}> (DMs closed?) — key \`${row.key_value}\``);
      }
    }
  } catch (err) {
    console.error('Maintenance error:', err);
  }
}

// ---------- interactions ----------

client.on('interactionCreate', async (interaction) => {
  // --- Panel buttons (public) ---
  if (interaction.isButton()) {
    try {
      if (interaction.customId === 'get_role') {
        const modal = new ModalBuilder().setCustomId('key_modal').setTitle('Enter your license key');
        const keyInput = new TextInputBuilder()
          .setCustomId('key_input')
          .setLabel('License key')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
        return await interaction.showModal(modal);
      }

      if (interaction.customId === 'get_script') {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.roles.cache.has(LICENSE_ROLE_ID)) {
          return interaction.reply({ content: 'You need a valid license role to get the script. Click **Get Role** first.', ephemeral: true });
        }
        const attachment = new AttachmentBuilder(SCRIPT_FILE_PATH);
        return interaction.reply({ content: 'Here is your script:', files: [attachment], ephemeral: true });
      }

      if (interaction.customId === 'my_key') {
        const { rows } = await pool.query(
          `SELECT key_value, hwid, expires_at FROM keys
           WHERE discord_id = $1 ORDER BY expires_at DESC LIMIT 10`,
          [interaction.user.id]
        );
        if (!rows.length) {
          return interaction.reply({ content: 'No key is linked to your account yet. Click **Get Role** and enter your key first.', ephemeral: true });
        }
        const embed = new EmbedBuilder()
          .setTitle(rows.length > 1 ? 'Your keys' : 'Your key')
          .setColor(0x5865F2);
        for (const r of rows) {
          const expired = new Date(r.expires_at) < new Date();
          embed.addFields({
            name: expired ? 'Expired' : 'Active',
            value:
              `Key: \`${r.key_value}\`\n` +
              `Expires: <t:${unix(r.expires_at)}:F> (<t:${unix(r.expires_at)}:R>)\n` +
              `HWID: ${r.hwid ? 'Locked' : 'Not locked yet'}`,
          });
        }
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (interaction.customId === 'reset_hwid') {
        const result = await selfResetHwid(interaction.user.id);
        return interaction.reply({ content: result.content, ephemeral: true });
      }
    } catch (err) {
      console.error('Button error:', err);
      return safeReply(interaction, { content: 'Something went wrong. Contact an admin.', ephemeral: true });
    }
    return;
  }

  // --- Key modal submission (panel: Get Role) ---
  if (interaction.isModalSubmit() && interaction.customId === 'key_modal') {
    const key = interaction.fields.getTextInputValue('key_input').trim();

    try {
      const result = await claimKey(interaction.user.id, key);
      if (!result.ok) return interaction.reply({ content: result.message, ephemeral: true });

      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(LICENSE_ROLE_ID);

      if (result.firstClaim) {
        logEvent(`**[KEY CLAIMED]** \`${result.row.key_value}\` claimed by <@${interaction.user.id}>`);
      }
      return interaction.reply({ content: 'Key valid! Role granted — you can now click **Get Script**.', ephemeral: true });
    } catch (err) {
      console.error('Error validating key:', err);
      return safeReply(interaction, { content: 'Something went wrong validating your key.', ephemeral: true });
    }
  }

  // --- Key modal submission (/redeem, works in DMs and any server) ---
  if (interaction.isModalSubmit() && interaction.customId === 'redeem_modal') {
    const key = interaction.fields.getTextInputValue('key_input').trim();

    try {
      const result = await claimKey(interaction.user.id, key);
      if (!result.ok) return interaction.reply({ content: result.message, ephemeral: true });

      await addLicenseRole(interaction.user.id); // best effort, only works if they're in your server

      if (result.firstClaim) {
        logEvent(`**[KEY CLAIMED]** \`${result.row.key_value}\` redeemed by <@${interaction.user.id}> via /redeem`);
      }
      return interaction.reply({ content: 'Key redeemed! Your Discord account is now whitelisted. Use **/script** to get the script.', ephemeral: true });
    } catch (err) {
      console.error('Error redeeming key:', err);
      return safeReply(interaction, { content: 'Something went wrong redeeming your key.', ephemeral: true });
    }
  }

  // --- User commands (anyone with the app installed) ---
  if (interaction.isChatInputCommand() && USER_COMMAND_NAMES.has(interaction.commandName)) {
    return handleUserCommand(interaction);
  }

  // --- Admin slash commands (role + channel restricted) ---
  if (!interaction.isChatInputCommand()) return;

  if (!isAllowed(interaction)) {
    return interaction.reply({ content: 'You cannot use this command here.', ephemeral: true });
  }

  const { commandName, options } = interaction;
  const admin = `<@${interaction.user.id}>`;

  try {
    if (commandName === 'addkey') {
      const duration = options.getInteger('duration');
      const key = genKey();
      await pool.query(
        `INSERT INTO keys (key_value, expires_at)
         VALUES ($1, NOW() + ($2 || ' days')::interval)`,
        [key, String(duration)]
      );
      logEvent(`**[KEY CREATED]** \`${key}\` (${duration} days) by ${admin}`);
      return interaction.reply({ content: `Key created: \`${key}\` (valid ${duration} days)`, ephemeral: true });
    }

    if (commandName === 'setduration') {
      const key = options.getString('key');
      const days = options.getInteger('days');
      const { rows } = await pool.query(
        `UPDATE keys
         SET expires_at = NOW() + ($1 || ' days')::interval,
             hwid = NULL, reminder_sent = FALSE, role_removed = FALSE
         WHERE key_value = $2
         RETURNING discord_id`,
        [String(days), key]
      );
      if (!rows.length) return interaction.reply({ content: 'Key not found.', ephemeral: true });

      let roleNote = '';
      if (rows[0].discord_id && (await addLicenseRole(rows[0].discord_id))) {
        roleNote = ' Owner\'s role restored.';
      }
      logEvent(`**[KEY RENEWED]** \`${key}\` set to ${days} days, HWID reset, by ${admin}`);
      return interaction.reply({ content: `Key \`${key}\` updated to ${days} days and HWID reset.${roleNote}`, ephemeral: true });
    }

    if (commandName === 'resethwid') {
      const key = options.getString('key');
      const { rowCount } = await pool.query(
        'UPDATE keys SET hwid = NULL WHERE key_value = $1', [key]
      );
      if (!rowCount) return interaction.reply({ content: 'Key not found.', ephemeral: true });
      logEvent(`**[HWID RESET]** key \`${key}\` reset by ${admin}`);
      return interaction.reply({ content: `HWID reset for \`${key}\`.`, ephemeral: true });
    }

    if (commandName === 'revokekey') {
      const key = options.getString('key');
      const { rows } = await pool.query(
        'DELETE FROM keys WHERE key_value = $1 RETURNING discord_id', [key]
      );
      if (!rows.length) return interaction.reply({ content: 'Key not found.', ephemeral: true });

      // a revoked key shouldn't leave its owner with the role
      const owner = rows[0].discord_id;
      let roleNote = '';
      if (owner && !(await hasActiveKey(owner)) && (await removeLicenseRole(owner))) {
        roleNote = ' Owner\'s role removed.';
      }
      logEvent(`**[KEY REVOKED]** \`${key}\` by ${admin}${owner ? ` (owner <@${owner}>)` : ''}`);
      return interaction.reply({ content: `Key \`${key}\` revoked.${roleNote}`, ephemeral: true });
    }

    if (commandName === 'listkeys') {
      const { rows } = await pool.query(
        'SELECT key_value, hwid, discord_id, expires_at FROM keys ORDER BY created_at DESC'
      );

      if (!rows.length) {
        return interaction.reply({ content: 'No keys found.', ephemeral: true });
      }

      const lines = rows.map(r => {
        const status = new Date(r.expires_at) < new Date() ? 'EXPIRED' : 'active';
        const hwid = r.hwid ? `\`${r.hwid}\`` : '*not locked yet*';
        const owner = r.discord_id ? `<@${r.discord_id}>` : '*unclaimed*';
        return `\`${r.key_value}\` — owner: ${owner} — hwid: ${hwid} — ${status} (until ${new Date(r.expires_at).toISOString().slice(0, 10)})`;
      });

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
      return;
    }

    if (commandName === 'panel') {
      const embed = new EmbedBuilder()
        .setTitle('Ibuprofen user panel')
        .setDescription(
          'Click **Get Role** and enter your license key to unlock access, then **Get Script** to receive the file.\n\n' +
          '**My Key** shows your key, expiry and HWID status.\n' +
          `**Reset HWID** unlinks your device (once every ${RESET_COOLDOWN_DAYS} days).`
        )
        .setColor(0x5865F2);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('get_role').setLabel('Get Role').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('get_script').setLabel('Get Script').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('my_key').setLabel('My Key').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('reset_hwid').setLabel('Reset HWID').setStyle(ButtonStyle.Secondary),
      );
      await interaction.channel.send({ embeds: [embed], components: [row] });
      return interaction.reply({ content: 'Panel posted.', ephemeral: true });
    }
  } catch (err) {
    console.error(err);
    return safeReply(interaction, { content: 'Something went wrong.', ephemeral: true });
  }
});

(async () => {
  await initSchema();
  await registerCommands();
  await client.login(TOKEN);

  // first run shortly after login, then every hour
  setTimeout(runMaintenance, 15_000);
  setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);
})();
