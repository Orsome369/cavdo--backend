// lib/keyPool.js
// ------------------------------------------------------------
// Shared Gemini API key pool, stored in Firestore instead of a single
// browser's localStorage. This is what makes "Add Key" in the Admin
// Panel actually reach every user/device, not just the one that added
// it — and lets a key that's hit its rate limit get skipped by
// everyone once enough clients have reported it, instead of every
// browser independently rediscovering the same dead key.
//
// Collection: geminiKeyPool
// Doc ID: the key itself (Firestore doc IDs can hold arbitrary strings,
// so no separate lookup index is needed for add/remove/dedupe).
// Doc shape: {
//   key: string,
//   addedAt: Timestamp,
//   cooldownUntil: Timestamp | null,   // set when enough clients report a 429
//   limitReports: [{ at: Timestamp }]  // trimmed to the last few, used to
//                                      // decide when to set a cooldown
// }
// ------------------------------------------------------------

const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { db: sharedDb } = require('./firebaseAdmin'); // adjust to match your actual export

const COLLECTION = 'geminiKeyPool';
// How long a key is hidden from /list once enough reports come in.
const COOLDOWN_MINUTES = 15;
// How many independent report-limit calls within the report window before
// we actually cool the key down (avoids one flaky client hiding a key that
// still works fine for everyone else).
const REPORTS_TO_TRIGGER_COOLDOWN = 2;
const REPORT_WINDOW_MINUTES = 10;

function db() {
  return sharedDb || getFirestore();
}

async function listActiveKeys() {
  const now = Date.now();
  const snap = await db().collection(COLLECTION).get();
  const keys = [];
  snap.forEach(doc => {
    const data = doc.data();
    const cooldownUntil = data.cooldownUntil ? data.cooldownUntil.toMillis() : 0;
    if (cooldownUntil > now) return; // still cooling down — skip it
    keys.push(data.key || doc.id);
  });
  return keys;
}

async function addKey(key) {
  const trimmed = (key || '').trim();
  if (!trimmed) throw new Error('Empty key');
  const ref = db().collection(COLLECTION).doc(trimmed);
  const existing = await ref.get();
  if (existing.exists) return { added: false, reason: 'duplicate' };
  await ref.set({
    key: trimmed,
    addedAt: FieldValue.serverTimestamp(),
    cooldownUntil: null,
    limitReports: [],
  });
  return { added: true };
}

async function removeKey(key) {
  const trimmed = (key || '').trim();
  if (!trimmed) return { removed: false };
  await db().collection(COLLECTION).doc(trimmed).delete();
  return { removed: true };
}

async function reportLimit(key) {
  const trimmed = (key || '').trim();
  if (!trimmed) return { ok: false };
  const ref = db().collection(COLLECTION).doc(trimmed);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, reason: 'unknown-key' };

  const data = snap.data();
  const now = Date.now();
  const windowStart = now - REPORT_WINDOW_MINUTES * 60 * 1000;
  const recentReports = (data.limitReports || [])
    .filter(r => r.at && r.at.toMillis && r.at.toMillis() > windowStart);

  recentReports.push({ at: Timestamp.now() });

  const update = { limitReports: recentReports.slice(-20) };
  if (recentReports.length >= REPORTS_TO_TRIGGER_COOLDOWN) {
    update.cooldownUntil = Timestamp.fromMillis(now + COOLDOWN_MINUTES * 60 * 1000);
  }
  await ref.update(update);
  return { ok: true, cooling: !!update.cooldownUntil };
}

module.exports = { listActiveKeys, addKey, removeKey, reportLimit };
