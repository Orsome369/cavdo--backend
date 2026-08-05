// /api/lint-code.js
// Real syntax validation for JS/JSX/TS/TSX and CSS — an actual parser for
// each, not the client-side bracket-balance heuristic. This closes two
// real gaps that new Function() (used client-side in index.html) can't:
//   1. new Function() can only parse plain JS — it throws on any TSX/JSX/TS
//      syntax even when that syntax is completely valid, so those languages
//      previously got NO real check at all, just the heuristic.
//   2. CSS was never checked for real syntax at all client-side (only
//      brace-balance), so a malformed selector/at-rule/value slipped
//      through as "no issue found".
//
// Uses esbuild's transform (parse-only concern: it never runs the code,
// only compiles/transforms it, same "compile don't execute" principle the
// client-side check already used) and postcss's real CSS parser. Both are
// genuine grammars used by real build tooling, not approximations.
//
// No Firebase / API keys needed here — this endpoint holds no secrets and
// does no external calls, so it's safe to keep separate from
// ultimate-chat.js's auth/quota concerns entirely.

const { applyCors } = require('../lib/cors');
const esbuild = require('esbuild');
const postcss = require('postcss');

const JS_LOADERS = {
  js: 'js', javascript: 'js',
  jsx: 'jsx',
  ts: 'ts', typescript: 'ts',
  tsx: 'tsx',
};
const CSS_LANGS = new Set(['css']);

// Per-snippet check. Returns a normalized shape regardless of which
// underlying library threw, so the caller doesn't need to know which
// checker ran.
function checkOne({ id, lang, content }) {
  const norm = (lang || '').toLowerCase();
  const text = typeof content === 'string' ? content : '';

  try {
    if (JS_LOADERS[norm]) {
      // logLevel:'silent' — we read errors from the thrown exception
      // ourselves rather than letting esbuild also print to stderr.
      esbuild.transformSync(text, { loader: JS_LOADERS[norm], logLevel: 'silent' });
      return { id, ok: true };
    }
    if (CSS_LANGS.has(norm)) {
      // .toString() forces postcss to fully walk the parsed tree (parse()
      // alone can be lazy about some structural errors); throws
      // CssSyntaxError with a real line/column on malformed CSS.
      postcss.parse(text).toString();
      return { id, ok: true };
    }
    // Not a language this endpoint has a real parser for (Python goes to
    // /api/lint-python; everything else has no safe server-side checker
    // available) — caller falls back to the client-side heuristic for it.
    return { id, ok: true, skipped: true, reason: `no real checker for "${lang || 'unknown'}" on this endpoint` };
  } catch (e) {
    if (Array.isArray(e.errors) && e.errors.length) {
      // esbuild's error shape.
      const first = e.errors[0];
      return {
        id, ok: false,
        message: first.text || 'syntax error',
        line: first.location ? first.location.line : null,
        column: first.location ? first.location.column : null,
      };
    }
    // postcss's CssSyntaxError (and anything else) has .reason/.line/.column
    // or just falls back to .message.
    return {
      id, ok: false,
      message: e.reason || e.message || String(e),
      line: typeof e.line === 'number' ? e.line : null,
      column: typeof e.column === 'number' ? e.column : null,
    };
  }
}

async function handler(req, res) {
  if (applyCors(req, res)) return; // handles OPTIONS preflight

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { snippets } = req.body || {};
  if (!Array.isArray(snippets) || !snippets.length) {
    res.status(400).json({ error: 'Body must be { snippets: [{ id, lang, content }, ...] }' });
    return;
  }

  // Hard caps so one malformed/abusive request can't tie up the function —
  // a real AI response realistically has a handful of code fences, never
  // hundreds, and no single fence is hundreds of KB.
  if (snippets.length > 20) {
    res.status(400).json({ error: 'Too many snippets in one request (max 20)' });
    return;
  }
  const oversized = snippets.find(s => typeof s.content === 'string' && s.content.length > 300000);
  if (oversized) {
    res.status(400).json({ error: `Snippet "${oversized.id}" exceeds the 300KB per-snippet limit` });
    return;
  }

  try {
    const results = snippets.map(checkOne);
    res.status(200).json({ results });
  } catch (err) {
    // A checker throwing something totally unexpected (not a normal parse
    // error) shouldn't 500 the whole batch silently — report it so the
    // caller can just fall back to the heuristic rather than hanging.
    console.error('lint-code unexpected error:', err);
    res.status(500).json({ error: 'Lint check failed', detail: err.message });
  }
}

// esbuild/postcss parsing is fast (milliseconds even for large files) — a
// short ceiling is enough and keeps a pathological/hanging input from
// tying up the function.
handler.config = { maxDuration: 30 };

module.exports = handler;
