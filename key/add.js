const { addKey } = require('../../lib/keyPool');
const { applyCors } = require('../../lib/cors');

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const { key } = req.body || {};
    if (!key || typeof key !== 'string') {
      res.status(400).json({ error: 'Missing key' });
      return;
    }
    const result = await addKey(key);
    res.status(200).json(result);
  } catch (err) {
    console.error('keys/add error:', err);
    res.status(500).json({ error: 'Failed to add key' });
  }
};
