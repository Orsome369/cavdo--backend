// lib/firebaseAdmin.js
// Initializes the Firebase Admin SDK once per serverless instance using
// a service account provided via environment variables. This works from
// any host (Vercel, etc.) and does NOT require Firebase's Blaze plan or
// Cloud Functions.

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // The private key is stored in the env var with literal \n sequences
  // (env vars can't hold real newlines cleanly), so we un-escape them here.
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Missing Firebase Admin env vars. Required: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY'
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

const db = admin.firestore();

module.exports = { admin, db };
