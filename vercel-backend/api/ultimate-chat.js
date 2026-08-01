// /api/ultimate-chat.js
// Vercel serverless function (Node.js runtime).
// Lives in the SAME Vercel project as your existing backend
// (vercel-backend-umber-mu.vercel.app), under the `api/` folder,
// alongside create-order.js / verify-payment.js / webhook.js.
//
// The frontend (cavdo.qd.je) is a DIFFERENT Vercel project/domain than
// this backend, so every call here is cross-origin — that's why this
// file needs CORS handling (via your existing lib/cors.js) and the
// frontend must call the full absolute URL, not a relative path.
//
// RESUMABLE GENERATION: the browser refreshing/closing mid-answer used to
// kill the response entirely, because the only thing driving generation
// was the fetch() call inside that specific tab. Now the frontend sends a
// `requestId` it generated itself; this function keeps writing the
// growing response to Firestore (generations/{requestId}) as it streams
// from NVIDIA, REGARDLESS of whether the client is still connected — a
// refreshed page can then poll GET /api/generation-status?requestId=...
// (see that file) to pick up exactly where it left off instead of losing
// the answer.
//
// SETUP (do this once, in the Vercel dashboard, not in code):
//   Project Settings -> Environment Variables -> Add:
//     Name:  NVIDIA_API_KEY
//     Value: <your NEW rotated nvapi-... key>
//   Then redeploy. Firebase Admin env vars (FIREBASE_PROJECT_ID etc.)
//   should already be set from your existing billing endpoints.
//
// IMPORTANT: rotate/regenerate your NVIDIA key before using it here —
// treat any key that's ever been pasted into a chat as burned.

const { applyCors } = require('../lib/cors');
const { db, admin } = require('../lib/firebaseAdmin');

// Model + generation params are chosen HERE, server-side, based on which
// tier the frontend says it wants — never taken from client-supplied
// model/param fields. That way a tampered request can't force a costlier
// model or unbounded token budget.
const TIER_CONFIG = {
  ultimate: {
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
    temperature: 1,
    top_p: 0.95,
    max_tokens: 16384,
    // reasoning_budget trimmed from 16384: full thinking budget plus a
    // full answer routinely runs past even a 60s function timeout,
    // which is the other likely source of the intermittent failures.
    extra_body: { chat_template_kwargs: { enable_thinking: true }, reasoning_budget: 8192 },
  },
  speed: {
    model: 'z-ai/glm-5.2',
    temperature: 1,
    top_p: 1,
    max_tokens: 16384,
  },
  lite: {
    model: 'nvidia/nemotron-3-nano-30b-a3b',
    // 30B total but only 3B ACTIVE params per token (hybrid Mamba+MoE) —
    // built specifically for low-latency use, genuinely the fastest
    // hosted option here, not just the smallest-sounding name.
    temperature: 1,
    top_p: 1,
    max_tokens: 4096,
    // Thinking mode OFF on purpose — Lite is meant to be the fastest tier,
    // and a hidden reasoning pass before every answer works against that.
  },
};

// How often (ms) to flush accumulated text to Firestore while streaming.
// Writing on every token would be a LOT of Firestore writes for a long
// answer; this throttles it while still keeping a resuming client's lag
// low.
const FIRESTORE_FLUSH_INTERVAL_MS = 700;

async function handler(req, res) {
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

  const { message, messages, tier, requestId } = req.body || {};
  const config = TIER_CONFIG[tier];
  if (!config) {
    res.status(400).json({ error: `Unknown or missing tier — expected one of: ${Object.keys(TIER_CONFIG).join(', ')}` });
    return;
  }

  // Accept either a single `message` string or a full `messages` array
  // (so you can pass conversation history for multi-turn chat).
  const chatMessages = Array.isArray(messages)
    ? messages
    : [{ role: 'user', content: message || '' }];

  if (!chatMessages.length || !chatMessages.some(m => m.content)) {
    res.status(400).json({ error: 'No message content provided' });
    return;
  }

  // requestId is optional (older/other callers can omit it) — without one
  // we just can't persist/resume this particular generation, but it still
  // streams normally.
  const genDocRef = requestId ? db.collection('generations').doc(String(requestId)) : null;
  let fullText = '';
  let lastFlushAt = 0;
  let lastFlushedLength = 0;

  async function flushToFirestore(done, errorMsg) {
    if (!genDocRef) return;
    if (!done && fullText.length === lastFlushedLength) return; // nothing new to save
    lastFlushedLength = fullText.length;
    try {
      await genDocRef.set({
        text: fullText,
        done: !!done,
        error: errorMsg || null,
        tier,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        // Cheap manual expiry marker — a scheduled cleanup job (or a
        // Firestore TTL policy on this field, configured once in the
        // Firebase console) can delete docs past this without any code
        // here needing to change.
        expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 60 * 60 * 1000),
      }, { merge: true });
    } catch (e) {
      // Persistence failing shouldn't take down the actual generation —
      // worst case, resume-after-refresh won't work for this one answer.
      console.error('generations Firestore write failed:', e);
    }
  }

  try {
    const upstreamBody = {
      model: config.model,
      messages: chatMessages,
      temperature: config.temperature,
      top_p: config.top_p,
      max_tokens: config.max_tokens,
      stream: true,
    };
    // IMPORTANT: chat_template_kwargs / reasoning_budget must be TOP-LEVEL
    // fields in the JSON sent to NVIDIA's endpoint. The OpenAI SDK's
    // `extra_body={...}` parameter merges its contents in at this level
    // automatically — it is a client-side convenience, not a literal
    // "extra_body" wrapper key. Nesting it as its own key makes NVIDIA's
    // API reject the whole request with a 400.
    if (config.extra_body) Object.assign(upstreamBody, config.extra_body);

    const upstream = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => '');
      await flushToFirestore(true, `Upstream error: ${errText}`);
      res.status(upstream.status || 502).json({ error: 'Upstream error', detail: errText });
      return;
    }

    // Re-stream as SSE, but re-emit our own JSON per chunk so the
    // frontend only ever sees `choices[0].delta.content` — reasoning /
    // chain-of-thought text (reasoning_content, when a model like
    // Nemotron sends it) is deliberately dropped here rather than shown
    // to the user or forwarded at all.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Writing to `res` after the client has disconnected (tab closed or
    // refreshed) is harmless — Node just drops it — but we deliberately
    // don't let a write error stop this loop, because we want generation
    // (and the Firestore save below) to keep going for the resume path
    // even if nobody is listening on this exact connection anymore.
    function safeWrite(chunk) {
      try { res.write(chunk); } catch (e) { /* client gone — keep generating regardless */ }
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep last partial line for next read

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          safeWrite('data: [DONE]\n\n');
          continue;
        }
        let evt;
        try { evt = JSON.parse(payload); } catch (e) { continue; }
        const content = evt?.choices?.[0]?.delta?.content;
        if (content) {
          fullText += content;
          safeWrite(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
          const now = Date.now();
          if (now - lastFlushAt >= FIRESTORE_FLUSH_INTERVAL_MS) {
            lastFlushAt = now;
            flushToFirestore(false).catch(() => {}); // fire-and-forget, don't block streaming
          }
        }
        // reasoning_content, if present, is intentionally not forwarded.
      }
    }

    await flushToFirestore(true);

    try { res.end(); } catch (e) { /* client already gone */ }
  } catch (err) {
    console.error('ultimate-chat proxy error:', err);
    await flushToFirestore(true, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Proxy failed', detail: err.message });
    } else {
      try { res.end(); } catch (e) {}
    }
  }
}

// Vercel kills a serverless function after its max duration (10s by
// default on many plans) — Nemotron Ultra's reasoning pass can easily run
// past that, which is the most likely cause of "sometimes it answers,
// sometimes it just cuts off mid-stream". This raises the ceiling to 60s.
// If your Vercel plan caps functions lower than that (check Settings ->
// Functions), lower this to match, or reduce Ultimate's reasoning_budget
// above instead.
handler.config = { maxDuration: 60 };

module.exports = handler;
