// db.js — shared Postgres pool used by both the bot and the API
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Railway injects this automatically
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000, // fail fast instead of hanging when the database is unreachable
  query_timeout: 15000,
});

// Safe to run on every start. Retried because the API and the bot both run it at boot
// and could collide on the same CREATE/ALTER.
async function initSchema() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
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
      await pool.query(`
        ALTER TABLE keys
          ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS role_removed BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS last_hwid_reset TIMESTAMP;
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS user_settings (
          discord_id TEXT PRIMARY KEY,
          public_replies BOOLEAN NOT NULL DEFAULT FALSE
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS status_checks (
          id SERIAL PRIMARY KEY,
          service TEXT NOT NULL,
          ok BOOLEAN NOT NULL,
          latency_ms INTEGER,
          checked_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS status_checks_checked_at_idx ON status_checks (checked_at);
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bot_state (
          k TEXT PRIMARY KEY,
          v TEXT
        );
      `);
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

module.exports = { pool, initSchema };
