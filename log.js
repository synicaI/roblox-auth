// log.js — posts events to a private Discord channel through a webhook.
// Works from both the bot and the API (they are separate services).
// Set LOG_WEBHOOK_URL on both services; if it's missing, logging is silently disabled.
const WEBHOOK_URL = process.env.LOG_WEBHOOK_URL;
const recent = new Map();
const DEDUPE_MS = 60_000;

// Strip characters that could break formatting in user-supplied values (keys/hwids sent to the API)
function clean(value, max = 80) {
  return String(value ?? '').replace(/[`\r\n]/g, '').slice(0, max);
}

async function logEvent(message, dedupeKey) {
  if (!WEBHOOK_URL) return;

  if (dedupeKey) {
    const now = Date.now();
    const last = recent.get(dedupeKey);
    if (last && now - last < DEDUPE_MS) return; // avoid flooding on repeated attempts
    recent.set(dedupeKey, now);
    if (recent.size > 1000) {
      for (const [k, t] of recent) if (now - t > DEDUPE_MS) recent.delete(k);
    }
  }

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Key Logs',
        content: String(message).slice(0, 1900),
        allowed_mentions: { parse: [] }, // show mentions without pinging anyone
      }),
    });
    if (!res.ok) console.error('Log webhook failed with status', res.status);
  } catch (err) {
    console.error('Log webhook error:', err.message);
  }
}

module.exports = { logEvent, clean };
