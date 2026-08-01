// api/webhook.js
// POST /api/webhook  (configured in Razorpay Dashboard -> Settings -> Webhooks)
//
// Authoritative server-to-server fallback. Fires even if the user's
// browser never calls verify-payment (closed tab, crashed app, flaky
// network). Verifies the webhook HMAC signature using
// RAZORPAY_WEBHOOK_SECRET (different secret from the API key secret),
// then activates the plan the same idempotent way verify-payment does.
//
// IMPORTANT: Vercel/Next-style body parsing can mangle the raw body needed
// for signature verification. This handler reads the raw body manually to
// be safe — see the config export at the bottom disabling the default
// body parser if you're on a Vercel runtime that supports it.

const crypto = require('crypto');
const { activatePlan } = require('../lib/plans');

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers['x-razorpay-signature'];

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    const valid =
      signature &&
      expectedSignature.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));

    if (!valid) {
      console.warn('webhook: signature mismatch');
      res.status(400).json({ error: 'Invalid webhook signature' });
      return;
    }

    const event = JSON.parse(rawBody);

    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      const orderId = payment.order_id;
      const paymentId = payment.id;
      const { uid, planKey } = payment.notes || {};

      if (!uid || !planKey) {
        console.error('webhook: payment.captured missing uid/planKey in notes', { orderId, paymentId });
        // Acknowledge so Razorpay doesn't retry forever on bad/legacy data.
        res.status(200).json({ ok: true, skipped: true });
        return;
      }

      await activatePlan({ uid, orderId, paymentId, planKey, source: 'webhook' });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('webhook error:', err);
    // Return 500 so Razorpay retries the webhook later.
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};
