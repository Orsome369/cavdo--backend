// api/create-order.js
// POST /api/create-order
// Body: { uid: string, planKey: 'lite' | 'speed' | 'ultimate' }
//
// Creates a Razorpay order using a price looked up server-side (never
// trusts a price sent by the client) and records a pending order doc in
// Firestore so verify-payment / webhook can later confirm it idempotently.

const Razorpay = require('razorpay');
const { db, admin } = require('../lib/firebaseAdmin');
const { getPlan } = require('../lib/plans');
const { applyCors } = require('../lib/cors');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

module.exports = async (req, res) => {
  if (applyCors(req, res)) return; // preflight OPTIONS request, already handled

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { uid, planKey } = req.body || {};

    if (!uid || typeof uid !== 'string') {
      res.status(400).json({ error: 'Missing or invalid uid' });
      return;
    }

    let plan;
    try {
      plan = getPlan(planKey);
    } catch (e) {
      res.status(400).json({ error: 'Invalid planKey' });
      return;
    }

    const order = await razorpay.orders.create({
      amount: plan.amountPaise,
      currency: 'INR',
      notes: { uid, planKey: plan.key },
    });

    // Record the order as pending, keyed by Razorpay's order id, so the
    // confirmation step (verify-payment or webhook) can look it up and
    // knows exactly which uid/plan it's allowed to activate.
    await db.collection('orders').doc(order.id).set({
      uid,
      planKey: plan.key,
      amountPaise: plan.amountPaise,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('create-order error:', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
};
