#!/usr/bin/env node
/**
 * create-admin.js
 * Creates (or resets) the admin account in Firestore.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/serviceAccount.json node create-admin.js
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/serviceAccount.json node create-admin.js "NewPassword"
 *
 * If no password argument is given, defaults to "Admin2026".
 */

'use strict';

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');
const crypto                  = require('crypto');

const PASSWORD = process.argv[2] || 'Admin2026';

async function hashPin(pin) {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

async function main() {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath) {
    console.error('❌  Set GOOGLE_APPLICATION_CREDENTIALS to your Firebase service account JSON path.');
    process.exit(1);
  }

  initializeApp({ credential: cert(require(credPath)) });
  const db = getFirestore();

  const pinHash = await hashPin(PASSWORD);
  const ref     = db.collection('users').doc('admin');

  await ref.set({
    nickname:       'Admin',
    isAdminAccount: true,
    isAdmin:        true,
    pinHash,
    totalPoints:    0,
    exactScores:    0,
    correctResults: 0,
    disabled:       false,
    createdAt:      new Date().toISOString(),
  });

  console.log('✅  Admin account created/updated.');
  console.log(`    Document ID : admin`);
  console.log(`    Password    : ${PASSWORD}`);
  console.log(`    Hash        : ${pinHash}`);
}

main().catch(e => { console.error(e); process.exit(1); });
