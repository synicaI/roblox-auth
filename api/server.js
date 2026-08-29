// api/server.js — the API your Roblox script calls
const express = require('express');
const { pool, initSchema } = require('../db');

const app = express();
app.use(express.json());

app.get('/', (_req, res) => res.json({ status: 'up' }));
app.get('/health', (_req, res) => res.json({ status: 'up' }));

// POST /verify { key, hwid }
app.post('/verify', async (req, res) => {
  try {
    const { key, hwid } = req.body || {};

    if (!key || !hwid) {
      return res.status(400).json({ ok: false, reason: 'missing_key_or_hwid' });
    }

    const { rows } = await pool.query(
      'SELECT * FROM keys WHERE key_value = $1',
      [key]
    );
    const row = rows[0];

    if (!row) {
      return res.status(404).json({ ok: false, reason: 'invalid_key' });
    }

    if (new Date(row.expires_at) < new Date()) {
      return res.status(403).json({ ok: false, reason: 'expired' });
    }

    if (!row.hwid) {
      // First execution — lock the key to this hwid
      await pool.query('UPDATE keys SET hwid = $1 WHERE id = $2', [hwid, row.id]);
      return res.json({ ok: true, reason: 'locked_to_hwid', expires_at: row.expires_at });
    }

    if (row.hwid !== hwid) {
      return res.status(403).json({ ok: false, reason: 'hwid_mismatch' });
    }

    return res.json({ ok: true, reason: 'valid', expires_at: row.expires_at });
  } catch (err) {
    console.error('Error in /verify:', err);
    return res.status(500).json({ ok: false, reason: 'server_error' });
  }
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
