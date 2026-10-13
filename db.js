// db.js — shared Postgres pool used by both the bot and the API
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Railway injects this automatically
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS keys (
      id SERIAL PRIMARY KEY,
      key_value TEXT UNIQUE NOT NULL,
      hwid TEXT,
      discord_id TEXT,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // New columns (safe to run on every start). Retry because the API and the bot
  // both run this at boot and could collide on the ALTER.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await pool.query(`
        ALTER TABLE keys
          ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS role_removed BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS last_hwid_reset TIMESTAMP;
      `);
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

module.exports = { pool, initSchema };
