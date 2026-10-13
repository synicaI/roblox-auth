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
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;            // hourly

const unix = (d) => Math.floor(new Date(d).getTime() / 1000);

const commands = [
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

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
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
        const { rows } = await pool.query(
          `SELECT id, key_value, hwid,
                  (last_hwid_reset IS NULL OR last_hwid_reset + ($2 || ' days')::interval <= NOW()) AS can_reset,
                  last_hwid_reset + ($2 || ' days')::interval AS available_at
           FROM keys
           WHERE discord_id = $1 AND expires_at > NOW()
           ORDER BY expires_at DESC LIMIT 1`,
          [interaction.user.id, String(RESET_COOLDOWN_DAYS)]
        );
        const row = rows[0];
        if (!row) {
          return interaction.reply({ content: 'You have no active key linked to your account.', ephemeral: true });
        }
        if (!row.hwid) {
          return interaction.reply({ content: 'Your HWID is not locked yet, there is nothing to reset.', ephemeral: true });
        }
        if (!row.can_reset) {
          return interaction.reply({ content: `You can reset your HWID again <t:${unix(row.available_at)}:R>.`, ephemeral: true });
        }

        // atomic update so a double click can't bypass the cooldown
        const result = await pool.query(
          `UPDATE keys SET hwid = NULL, last_hwid_reset = NOW()
           WHERE id = $1 AND hwid IS NOT NULL
             AND (last_hwid_reset IS NULL OR last_hwid_reset + ($2 || ' days')::interval <= NOW())`,
          [row.id, String(RESET_COOLDOWN_DAYS)]
        );
        if (!result.rowCount) {
          return interaction.reply({ content: 'Reset is not available right now.', ephemeral: true });
        }
        logEvent(`**[HWID RESET]** <@${interaction.user.id}> reset their own HWID — key \`${row.key_value}\``);
        return interaction.reply({
          content: `Your HWID has been reset. You can do this again in ${RESET_COOLDOWN_DAYS} days. Run the script to lock it to your new device.`,
          ephemeral: true,
        });
      }
    } catch (err) {
      console.error('Button error:', err);
      return safeReply(interaction, { content: 'Something went wrong. Contact an admin.', ephemeral: true });
    }
    return;
  }

  // --- Key modal submission ---
  if (interaction.isModalSubmit() && interaction.customId === 'key_modal') {
    const key = interaction.fields.getTextInputValue('key_input').trim();

    try {
      const { rows } = await pool.query('SELECT * FROM keys WHERE key_value = $1', [key]);
      const row = rows[0];

      if (!row) {
        return interaction.reply({ content: 'Invalid key.', ephemeral: true });
      }
      if (new Date(row.expires_at) < new Date()) {
        return interaction.reply({ content: 'This key has expired.', ephemeral: true });
      }
      if (row.discord_id && row.discord_id !== interaction.user.id) {
        return interaction.reply({ content: 'This key is already linked to another Discord account.', ephemeral: true });
      }

      const firstClaim = !row.discord_id;
      if (firstClaim) {
        await pool.query('UPDATE keys SET discord_id = $1 WHERE id = $2', [interaction.user.id, row.id]);
      }

      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(LICENSE_ROLE_ID);

      if (firstClaim) {
        logEvent(`**[KEY CLAIMED]** \`${row.key_value}\` claimed by <@${interaction.user.id}>`);
      }
      return interaction.reply({ content: 'Key valid! Role granted — you can now click **Get Script**.', ephemeral: true });
    } catch (err) {
      console.error('Error validating key:', err);
      return safeReply(interaction, { content: 'Something went wrong validating your key.', ephemeral: true });
    }
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
