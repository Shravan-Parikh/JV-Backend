#!/usr/bin/env node
/**
 * create-user.js — provision a JV Enterprises account from the terminal.
 *
 * Sign-ups are closed, and the admin API needs an admin to already exist, so
 * this is how every account is created.
 *
 *   node scripts/create-user.js "Jayesh Parikh" jventerprisesilvassa@gmail.com
 *   node scripts/create-user.js "Jayesh Parikh" jv@example.com "chosen-password"
 *
 * The role is derived from ADMIN_EMAILS in .env — no flag needed.
 * If the account already exists in Firebase Auth, this signs in instead and
 * repairs the Firestore profile.
 */

import { randomBytes } from 'node:crypto';
import { config } from '../src/config.js';
import { USERS } from '../src/collections.js';
import { signUp, signIn, getDoc, setDoc, FirebaseError } from '../src/firebase.js';

const [, , name, email, providedPassword] = process.argv;

if (!name || !email) {
  console.error('Usage: node scripts/create-user.js "Full Name" email@example.com [password]');
  process.exit(1);
}

/** Readable but strong: 18 URL-safe chars ≈ 107 bits. */
const generatePassword = () => randomBytes(14).toString('base64url');

const password = providedPassword || generatePassword();
const role = config.adminEmails.includes(email.toLowerCase()) ? 'admin' : 'member';

async function main() {
  let auth;
  let created = true;
  try {
    auth = await signUp(email, password, name);
  } catch (e) {
    if (e instanceof FirebaseError && e.code === 'EMAIL_EXISTS') {
      if (!providedPassword) {
        console.error(
          `\n✗ ${email} already exists. Re-run with its password to repair the profile:\n` +
            `  node scripts/create-user.js "${name}" ${email} "<existing-password>"\n`,
        );
        process.exit(1);
      }
      auth = await signIn(email, password);
      created = false;
    } else {
      throw e;
    }
  }

  const existing = await getDoc(USERS, auth.uid, auth.idToken);
  await setDoc(
    USERS,
    auth.uid,
    {
      uid: auth.uid,
      name,
      email: email.toLowerCase(),
      role,
      createdAt: existing?.createdAt ? new Date(existing.createdAt) : new Date(),
      lastLoginAt: new Date(),
    },
    auth.idToken,
  );

  console.log(`\n✓ ${created ? 'Created' : 'Repaired'} account\n`);
  console.log(`  Name      ${name}`);
  console.log(`  Email     ${email}`);
  if (created) console.log(`  Password  ${password}`);
  console.log(`  Role      ${role}`);
  console.log(`  UID       ${auth.uid}`);
  console.log(`\n  Firestore profile written to ${USERS}/${auth.uid}\n`);
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}\n`);
  if (String(e.message).toLowerCase().includes('permission')) {
    console.error(
      'Firestore denied the write. Publish the jv_* rules from firestore.rules\n' +
        '(merge them into the existing ruleset — do not replace it).\n',
    );
  }
  process.exit(1);
});
