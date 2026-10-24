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
          ADD COLUMN IF NOT EXISTS last_hwid_reset TIMESTAMP,
          ADD COLUMN IF NOT EXISTS frozen BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP;
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
      await pool.query(`
        CREATE TABLE IF NOT EXISTS changelog (
          message_id TEXT PRIMARY KEY,
          guild_id TEXT,
          content TEXT NOT NULL DEFAULT '',
          attachment_count INTEGER NOT NULL DEFAULT 0,
          created_ms BIGINT NOT NULL
        );
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS changelog_created_idx ON changelog (created_ms DESC);
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS verify_log (
          id SERIAL PRIMARY KEY,
          key_value TEXT,
          hwid TEXT,
          roblox_name TEXT,
          result TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS verify_log_key_idx ON verify_log (key_value, created_at DESC);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS verify_log_created_idx ON verify_log (created_at);`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS blacklist (
          id SERIAL PRIMARY KEY,
          type TEXT NOT NULL,
          value TEXT NOT NULL,
          reason TEXT,
          added_by TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          UNIQUE (type, value)
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS media_posts (
          id SERIAL PRIMARY KEY,
          message_id TEXT UNIQUE,
          uploader_id TEXT NOT NULL,
          anonymous BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS media_posts_uploader_idx ON media_posts (uploader_id, created_at DESC);`);
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

module.exports = { pool, initSchema };
