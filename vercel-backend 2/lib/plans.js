// lib/plans.js
// Single source of truth for plan pricing and the logic that grants a plan
// to a user. Both api/verify-payment.js (client-confirmed path) and
// api/webhook.js (server-authoritative fallback path) call activatePlan()
// so a payment only ever gets applied once, no matter which path fires
// first or if both fire.

const { db, admin } = require('./firebaseAdmin');

// Prices are in the smallest currency unit (paise) because that's what
// Razorpay's `amount` field expects. NEVER trust a price sent by the
// client — always look it up here server-side.
const PLANS = {
  lite: { key: 'lite', label: 'Lite', amountPaise: 10000, durationMs: 30 * 24 * 60 * 60 * 1000 },
  speed: { key: 'speed', label: 'Speed', amountPaise: 20000, durationMs: 30 * 24 * 60 * 60 * 1000 },
  ultimate: { key: 'ultimate', label: 'Ultimate', amountPaise: 50000, durationMs: 30 * 24 * 60 * 60 * 1000 },
};

function getPlan(planKey) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error(`Unknown plan key: ${planKey}`);
  return plan;
}

/**
 * Activates a plan for a user based on a Razorpay order/payment, idempotently.
 * Safe to call twice for the same orderId (e.g. once from verify-payment,
 * once from the webhook) — the second call is a no-op.
 *
 * @param {Object} params
 * @param {string} params.uid - Firebase Auth uid of the paying user
 * @param {string} params.orderId - Razorpay order id (used as idempotency key)
 * @param {string} params.paymentId - Razorpay payment id
 * @param {string} params.planKey - one of 'lite' | 'speed' | 'ultimate'
 * @param {string} params.source - 'verify-payment' | 'webhook' (for audit trail)
 */
async function activatePlan({ uid, orderId, paymentId, planKey, source }) {
  const plan = getPlan(planKey);
  const orderRef = db.collection('orders').doc(orderId);
  const billingRef = db.collection('billing').doc(uid);

  await db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);

    if (!orderSnap.exists) {
      throw new Error(`Order ${orderId} not found — cannot activate plan without a known order`);
    }

    const orderData = orderSnap.data();

    if (orderData.status === 'fulfilled') {
      // Already activated by the other path (verify-payment vs webhook race).
      // This is expected and NOT an error.
      return;
    }

    if (orderData.uid !== uid) {
      throw new Error(`Order ${orderId} does not belong to uid ${uid}`);
    }

    if (orderData.planKey !== planKey) {
      throw new Error(`Order ${orderId} plan mismatch: expected ${orderData.planKey}, got ${planKey}`);
    }

    const now = Date.now();
    const end = now + plan.durationMs;

    tx.set(
      billingRef,
      {
        plan: plan.key,
        planLabel: plan.label,
        status: 'active',
        planStart: now,
        planEnd: end,
        lastOrderId: orderId,
        lastPaymentId: paymentId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: source,
      },
      { merge: true }
    );

    tx.update(orderRef, {
      status: 'fulfilled',
      paymentId,
      fulfilledAt: admin.firestore.FieldValue.serverTimestamp(),
      fulfilledBy: source,
    });
  });
}

module.exports = { PLANS, getPlan, activatePlan };
