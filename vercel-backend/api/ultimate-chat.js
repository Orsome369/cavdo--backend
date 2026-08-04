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
//
// `codeModel` (optional): when the request's `mode` is 'code', this model
// is used INSTEAD of `model` for that tier. Added because a single
// generalist model was being asked to do everything — including code —
// and NVIDIA's catalog has a real coding specialist available:
// qwen/qwen3-coder-480b-a35b-instruct, a 480B MoE model NVIDIA's own
// model card describes as achieving results on agentic coding benchmarks
// comparable to Claude Sonnet. It's a plain instruct model (no
// thinking-mode params), so `extra_body` is tracked per-model below
// rather than assumed to apply to whichever model ends up selected.
const TIER_CONFIG = {
  ultimate: {
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
    temperature: 1,
    top_p: 0.95,
    // 8192 was too tight: it hard-caps EVERY response at the API level
    // regardless of what the prompt says, so a request that legitimately
    // needs more room (the user explicitly asking for something
    // full/production/complete, e.g. a whole single-file game with many
    // named systems) would hit a REAL finish_reason:'length' truncation —
    // which then correctly triggered auto-continue, but produced visible
    // "already complete, no continuation needed" junk once the model's
    // own follow-up legitimately had nothing left to add. Raised back up
    // so the ceiling is rarely the reason a genuinely large, explicitly-
    // requested response gets cut. The prompt (see the code-mode length
    // guidance in index.html) still steers ordinary/small requests toward
    // short output on its own — this larger number only matters for the
    // minority of requests that actually need it.
    max_tokens: 16384,
    extra_body: { chat_template_kwargs: { enable_thinking: true }, reasoning_budget: 5120 },
    codeModel: 'qwen/qwen3-coder-480b-a35b-instruct',
    // Qwen's own recommended sampling settings for this model (their
    // model card/docs) — different from Nemotron's, and this model has
    // no reasoning_budget/enable_thinking knobs to set, so no extra_body
    // here at all.
    codeModelParams: { temperature: 0.7, top_p: 0.8, max_tokens: 16384 },
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

  const { message, messages, tier, requestId, mode } = req.body || {};
  const config = TIER_CONFIG[tier];
  if (!config) {
    res.status(400).json({ error: `Unknown or missing tier — expected one of: ${Object.keys(TIER_CONFIG).join(', ')}` });
    return;
  }

  // Resolve which actual model/params this request uses. `mode` is just a
  // routing hint from the client ('code' vs anything else) — it can't
  // force a different tier or budget, only pick between the tier's own
  // pre-approved model and its optional coding-specialist model.
  const useCodeModel = mode === 'code' && config.codeModel;
  const resolvedModel = useCodeModel ? config.codeModel : config.model;
  const resolvedParams = useCodeModel && config.codeModelParams
    ? config.codeModelParams
    : { temperature: config.temperature, top_p: config.top_p, max_tokens: config.max_tokens };
  // extra_body (thinking-mode params) is specific to the base model's
  // architecture — never carried over to a different model that wasn't
  // built with those params in mind.
  const resolvedExtraBody = useCodeModel ? null : config.extra_body;

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
  let lastFlushedLength = -1; // -1 (not 0) so the very first flush, even with empty text, isn't skipped by the "nothing new" check below

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
    if (genDocRef) {
      // Written BEFORE the upstream call so a resume poll that lands during
      // a model's silent "thinking" phase (no visible content yet, could be
      // several seconds on Ultimate) sees done:false rather than a 404 that
      // would wrongly look like the generation was lost.
      await flushToFirestore(false);
    }

    const upstreamBody = {
      model: resolvedModel,
      messages: chatMessages,
      temperature: resolvedParams.temperature,
      top_p: resolvedParams.top_p,
      max_tokens: resolvedParams.max_tokens,
      stream: true,
    };
    // IMPORTANT: chat_template_kwargs / reasoning_budget must be TOP-LEVEL
    // fields in the JSON sent to NVIDIA's endpoint. The OpenAI SDK's
    // `extra_body={...}` parameter merges its contents in at this level
    // automatically — it is a client-side convenience, not a literal
    // "extra_body" wrapper key. Nesting it as its own key makes NVIDIA's
    // API reject the whole request with a 400.
    if (resolvedExtraBody) Object.assign(upstreamBody, resolvedExtraBody);

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
      // Tells Vercel's edge proxy (and any nginx-like layer in front of it)
      // not to buffer this response and wait for it to finish before
      // forwarding bytes — without this, some proxy layers hold the whole
      // SSE stream and flush it in one shot at the end, which looks
      // exactly like "the reply appears all at once, then sometimes gets
      // cut off" instead of a real token-by-token stream.
      'X-Accel-Buffering': 'no',
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
        const choice = evt?.choices?.[0];
        const content = choice?.delta?.content;
        // finish_reason ('length' when max_tokens was hit, 'stop' on a
        // normal end) previously never left this function — only
        // delta.content was re-packaged below, so the frontend's
        // finish_reason === 'length' truncation check could NEVER fire
        // for this proxy path, no matter how good that frontend logic
        // was. This was the actual reason plain-text answers (no code
        // fence to fall back on) just stopped dead instead of
        // triggering auto-continue: the signal that says "I was cut
        // off" was being silently dropped right here.
        const finishReason = choice?.finish_reason || null;
        if (content) fullText += content;
        if (content || finishReason) {
          safeWrite(`data: ${JSON.stringify({ choices: [{ delta: { content: content || '' }, finish_reason: finishReason }] })}\n\n`);
        }
        if (content) {
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

// Vercel kills a serverless function after its max duration — Nemotron
// Ultra's reasoning pass can easily run past a short one, which is the
// most likely cause of "sometimes it answers, sometimes it just cuts off
// mid-stream".
//
// 60 was previously the real hard ceiling on most plans, so that's what
// this was set to. As of Vercel's 2026 "Fluid compute" rollout, Fluid is
// on by default for functions and raises that ceiling a lot further:
//   - Hobby (free) plan: up to 300s (5 min) with Fluid compute
//   - Pro / Enterprise: up to 800s (13+ min) with Fluid compute
// 280 leaves a safety margin under the 300s Hobby ceiling either way. If
// this project is on Pro/Enterprise you can safely raise it further (e.g.
// 780) for even fewer auto-continue round-trips on very long replies.
//
// IMPORTANT: this alone isn't enough if Fluid compute is OFF for this
// project (older projects don't have it enabled automatically) — check
// Vercel dashboard -> Project Settings -> Functions -> "Fluid compute" is
// toggled on, then redeploy. With it off, Hobby is still hard-capped at
// 60s no matter what this file says, and Vercel will actually reject the
// deploy if maxDuration here exceeds what your plan allows.
handler.config = { maxDuration: 280 };

module.exports = handler;
