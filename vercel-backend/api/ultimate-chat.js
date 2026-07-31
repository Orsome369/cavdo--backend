// /api/ultimate-chat.js
// Vercel serverless function (Node.js runtime).
// Drop this file into the SAME Vercel project as your existing backend
// (the one at vercel-backend-umber-mu.vercel.app), under the `api/`
// folder, alongside create-order.js / verify-payment.js / webhook.js —
// Vercel auto-routes it to /api/ultimate-chat.
//
// The frontend (cavdo.qd.je) is a DIFFERENT Vercel project/domain than
// this backend, so every call here is cross-origin — that's why this
// file needs CORS handling (via your existing lib/cors.js) and the
// frontend must call the full absolute URL, not a relative path.
//
// SETUP (do this once, in the Vercel dashboard, not in code):
//   Project Settings -> Environment Variables -> Add:
//     Name:  NVIDIA_API_KEY
//     Value: <your NEW rotated nvapi-... key>
//   Then redeploy.
//
// IMPORTANT: rotate/regenerate your NVIDIA key before using it here —
// treat the old one (shared in chat) as burned.

const { applyCors } = require('../lib/cors');

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return; // handles OPTIONS preflight, sets Access-Control-* headers

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server missing NVIDIA_API_KEY env var' });
    return;
  }

  const { message, messages, temperature = 1, top_p = 1, max_tokens = 16384 } = req.body || {};

  // Accept either a single `message` string or a full `messages` array
  // (so you can pass conversation history for multi-turn chat).
  const chatMessages = Array.isArray(messages)
    ? messages
    : [{ role: 'user', content: message || '' }];

  if (!chatMessages.length || !chatMessages.some(m => m.content)) {
    res.status(400).json({ error: 'No message content provided' });
    return;
  }

  try {
    const upstream = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'z-ai/glm-5.2',
        messages: chatMessages,
        temperature,
        top_p,
        max_tokens,
        stream: true,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => '');
      res.status(upstream.status || 502).json({ error: 'Upstream error', detail: errText });
      return;
    }

    // Stream Server-Sent Events straight through to the browser.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Forward raw SSE chunks (lines like: data: {...}\n\n)
      res.write(decoder.decode(value, { stream: true }));
    }

    res.end();
  } catch (err) {
    console.error('ultimate-chat proxy error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Proxy failed', detail: err.message });
    } else {
      res.end();
    }
  }
}
