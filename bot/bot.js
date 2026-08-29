// bot/bot.js — key management slash commands, restricted to a role + channel
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  AttachmentBuilder,
} = require('discord.js');
const crypto = require('crypto');
const path = require('path');
const { pool, initSchema } = require('../db');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;       // for fast guild-scoped command registration
const ALLOWED_ROLE_ID = process.env.ALLOWED_ROLE_ID; // role permitted to run admin commands
const ALLOWED_CHANNEL_ID = process.env.ALLOWED_CHANNEL_ID; // channel admin commands work in
const LICENSE_ROLE_ID = process.env.LICENSE_ROLE_ID; // role granted once a valid key is entered
const SCRIPT_FILE_PATH = process.env.SCRIPT_FILE_PATH || path.join(__dirname, '..', 'assets', 'script.lua');

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
    .setDescription('Post the Get Role / Get Script button panel in this channel'),
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
  return crypto.randomBytes(12).toString('hex'); // e.g. 24-char key
}

function isAllowed(interaction) {
  if (interaction.channelId !== ALLOWED_CHANNEL_ID) return false;
  return interaction.member.roles.cache.has(ALLOWED_ROLE_ID);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on('interactionCreate', async (interaction) => {
  // --- Panel buttons (public, anyone in the server can click) ---
  if (interaction.isButton()) {
    if (interaction.customId === 'get_role') {
      const modal = new ModalBuilder()
        .setCustomId('key_modal')
        .setTitle('Enter your license key');

      const keyInput = new TextInputBuilder()
        .setCustomId('key_input')
        .setLabel('License key')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
      return interaction.showModal(modal);
    }

    if (interaction.customId === 'get_script') {
      try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.roles.cache.has(LICENSE_ROLE_ID)) {
          return interaction.reply({ content: 'You need a valid license role to get the script. Click **Get Role** first.', ephemeral: true });
        }
        const attachment = new AttachmentBuilder(SCRIPT_FILE_PATH);
        return interaction.reply({ content: 'Here is your script:', files: [attachment], ephemeral: true });
      } catch (err) {
        console.error('Error sending script:', err);
        return interaction.reply({ content: 'Could not send the script file. Contact an admin.', ephemeral: true });
      }
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

      if (!row.discord_id) {
        await pool.query('UPDATE keys SET discord_id = $1 WHERE id = $2', [interaction.user.id, row.id]);
      }

      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(LICENSE_ROLE_ID);

      return interaction.reply({ content: 'Key valid! Role granted — you can now click **Get Script**.', ephemeral: true });
    } catch (err) {
      console.error('Error validating key:', err);
      return interaction.reply({ content: 'Something went wrong validating your key.', ephemeral: true });
    }
  }

  // --- Admin slash commands (role + channel restricted) ---
  if (!interaction.isChatInputCommand()) return;

  if (!isAllowed(interaction)) {
    return interaction.reply({ content: 'You cannot use this command here.', ephemeral: true });
  }

  const { commandName, options } = interaction;

  try {
    if (commandName === 'addkey') {
      const duration = options.getInteger('duration');
      const key = genKey();
      await pool.query(
        `INSERT INTO keys (key_value, discord_id, expires_at)
         VALUES ($1, $2, NOW() + ($3 || ' days')::interval)`,
        [key, interaction.user.id, duration]
      );
      return interaction.reply({ content: `Key created: \`${key}\` (valid ${duration} days)`, ephemeral: true });
    }

    if (commandName === 'setduration') {
      const key = options.getString('key');
      const days = options.getInteger('days');
      const { rowCount } = await pool.query(
        `UPDATE keys SET expires_at = NOW() + ($1 || ' days')::interval, hwid = NULL
         WHERE key_value = $2`,
        [days, key]
      );
      if (!rowCount) return interaction.reply({ content: 'Key not found.', ephemeral: true });
      return interaction.reply({ content: `Key \`${key}\` updated to ${days} days and HWID reset.`, ephemeral: true });
    }

    if (commandName === 'resethwid') {
      const key = options.getString('key');
      const { rowCount } = await pool.query(
        `UPDATE keys SET hwid = NULL WHERE key_value = $1`, [key]
      );
      if (!rowCount) return interaction.reply({ content: 'Key not found.', ephemeral: true });
      return interaction.reply({ content: `HWID reset for \`${key}\`.`, ephemeral: true });
    }

    if (commandName === 'revokekey') {
      const key = options.getString('key');
      const { rowCount } = await pool.query(`DELETE FROM keys WHERE key_value = $1`, [key]);
      if (!rowCount) return interaction.reply({ content: 'Key not found.', ephemeral: true });
      return interaction.reply({ content: `Key \`${key}\` revoked.`, ephemeral: true });
    }

    if (commandName === 'listkeys') {
      const { rows } = await pool.query(
        `SELECT key_value, hwid, expires_at FROM keys ORDER BY created_at DESC`
      );

      if (!rows.length) {
        return interaction.reply({ content: 'No keys found.', ephemeral: true });
      }

      const lines = rows.map(r => {
        const status = new Date(r.expires_at) < new Date() ? 'EXPIRED' : 'active';
        const hwid = r.hwid ? `\`${r.hwid}\`` : '*not locked yet*';
        return `\`${r.key_value}\` — hwid: ${hwid} — ${status} (until ${new Date(r.expires_at).toISOString().slice(0, 10)})`;
      });

      // Discord messages cap at ~2000 chars — chunk into multiple messages if needed
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
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('get_role').setLabel('Get Role').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('get_script').setLabel('Get Script').setStyle(ButtonStyle.Success),
      );
      await interaction.channel.send({
        content: '**License Panel**\nClick **Get Role** and enter your license key to unlock access, then **Get Script** to receive the file.',
        components: [row],
      });
      return interaction.reply({ content: 'Panel posted.', ephemeral: true });
    }
  } catch (err) {
    console.error(err);
    return interaction.reply({ content: 'Something went wrong.', ephemeral: true });
  }
});

(async () => {
  await initSchema();
  await registerCommands();
  await client.login(TOKEN);
})();
