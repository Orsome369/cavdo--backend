// api/create-order.js  — TEMPORARY DEBUG VERSION
// Same logic as before, but split into two try/catch blocks so we know
// exactly which step fails, and the response includes the real error
// message + a "stage" field. Once you've found the bug, revert to a
// version that returns only { error: 'Failed to create order' } — you
// don't want raw error internals exposed in production long-term.

const Razorpay = require('razorpay');
const { db, admin } = require('../lib/firebaseAdmin');
const { getPlan } = require('../lib/plans');
const { applyCors } = require('../lib/cors');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { uid, planKey } = req.body || {};

  if (!uid || typeof uid !== 'string') {
    res.status(400).json({ error: 'Missing or invalid uid' });
    return;
  }

  let plan;
  try {
    plan = getPlan(planKey);
  } catch (e) {
    res.status(400).json({ error: 'Invalid planKey', received: planKey });
    return;
  }

  // Stage 1: Razorpay order creation
  let order;
  try {
    order = await razorpay.orders.create({
      amount: plan.amountPaise,
      currency: 'INR',
      notes: { uid, planKey: plan.key },
    });
  } catch (err) {
    console.error('create-order: Razorpay order creation failed:', err);
    res.status(500).json({
      error: 'Razorpay order creation failed',
      stage: 'razorpay',
      detail: err && err.error ? err.error : (err && err.message) || String(err),
    });
    return;
  }

  // Stage 2: Firestore write
  try {
    await db.collection('orders').doc(order.id).set({
      uid,
      planKey: plan.key,
      amountPaise: plan.amountPaise,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('create-order: Firestore write failed:', err);
    res.status(500).json({
      error: 'Firestore write failed',
      stage: 'firestore',
      detail: (err && err.message) || String(err),
    });
    return;
  }

  res.status(200).json({
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: process.env.RAZORPAY_KEY_ID,
  });
};
