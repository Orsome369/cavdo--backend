// /api/generation-status.js
// Vercel serverless function (Node.js runtime). Lives alongside
// ultimate-chat.js in the same project.
//
// GET /api/generation-status?requestId=...&ack=1
//
// Returns the current saved state of a generation started via
// ultimate-chat.js: { text, done, error }. The frontend polls this after
// a page refresh/reconnect to recover an answer that was still streaming
// when the tab reloaded, instead of losing it.
//
// Pass ack=1 once the client has fully consumed a `done: true` response —
// this deletes the Firestore doc immediately instead of waiting for it to
// expire, keeping the collection small.

const { applyCors } = require('../lib/cors');
const { db } = require('../lib/firebaseAdmin');

async function handler(req, res) {
  if (applyCors(req, res)) return;

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const requestId = req.query && req.query.requestId;
  if (!requestId) {
    res.status(400).json({ error: 'Missing requestId query param' });
    return;
  }

  try {
    const docRef = db.collection('generations').doc(String(requestId));
    const snap = await docRef.get();

    if (!snap.exists) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const data = snap.data() || {};
    res.status(200).json({
      text: data.text || '',
      done: !!data.done,
      error: data.error || null,
    });

    if (data.done && req.query.ack) {
      docRef.delete().catch(() => {}); // best-effort cleanup, don't block the response
    }
  } catch (err) {
    console.error('generation-status error:', err);
    res.status(500).json({ error: 'Lookup failed', detail: err.message });
  }
}

module.exports = handler;
