// bot/bot.js — key management slash commands, restricted to a role + channel
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits,
} = require('discord.js');
const crypto = require('crypto');
const { pool, initSchema } = require('../db');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;       // for fast guild-scoped command registration
const ALLOWED_ROLE_ID = process.env.ALLOWED_ROLE_ID; // role permitted to run these commands
const ALLOWED_CHANNEL_ID = process.env.ALLOWED_CHANNEL_ID; // channel these commands work in

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
