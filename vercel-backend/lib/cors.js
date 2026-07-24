// lib/cors.js
// The frontend (https://cavdo.opik.net) and this backend
// (https://vercel-backend-umber-mu.vercel.app) are different origins, so
// the browser requires the server to explicitly allow cross-origin
// requests via CORS headers — otherwise every fetch() call from the site
// fails with a generic "NetworkError" before the request body is even
// sent. This also handles the CORS "preflight" OPTIONS request the
// browser sends automatically before any POST with a JSON body.
//
// Restricting ALLOWED_ORIGIN to your actual site (rather than using '*')
// prevents some other website from calling your payment endpoints
// directly from a visitor's browser.

const ALLOWED_ORIGIN = 'https://cavdo.qd.je';

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true; // caller should stop here — preflight handled
  }
  return false;
}

module.exports = { applyCors };
