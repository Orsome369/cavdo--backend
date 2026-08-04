// api/verify-payment.js
// POST /api/verify-payment
// Body: { uid, orderId (razorpay_order_id), paymentId (razorpay_payment_id),
//         signature (razorpay_signature), planKey }
//
// This is the fast/optimistic confirmation path, called by the browser
// right after Razorpay Checkout succeeds. It verifies the HMAC signature
// Razorpay returns, proving the payment is genuine, then activates the
// plan. api/webhook.js is the authoritative fallback in case this call
// never fires (tab closed, network drop, etc.) — activatePlan() is
// idempotent so whichever path runs first wins and the other is a no-op.

const crypto = require('crypto');
const { activatePlan } = require('../lib/plans');
const { applyCors } = require('../lib/cors');

module.exports = async (req, res) => {
  if (applyCors(req, res)) return; // preflight OPTIONS request, already handled

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { uid, orderId, paymentId, signature, planKey } = req.body || {};

    if (!uid || !orderId || !paymentId || !signature || !planKey) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const valid =
      expectedSignature.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));

    if (!valid) {
      console.warn('verify-payment: signature mismatch', { orderId, paymentId, uid });
      res.status(400).json({ error: 'Invalid payment signature' });
      return;
    }

    await activatePlan({ uid, orderId, paymentId, planKey, source: 'verify-payment' });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('verify-payment error:', err);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
};
