const { listActiveKeys } = require('../../lib/keyPool');
const { applyCors } = require('../../lib/cors'); // reuse your existing CORS helper

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return; // handles OPTIONS preflight, sets headers
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const keys = await listActiveKeys();
    res.status(200).json({ keys });
  } catch (err) {
    console.error('keys/list error:', err);
    res.status(500).json({ error: 'Failed to load key pool' });
  }
};
