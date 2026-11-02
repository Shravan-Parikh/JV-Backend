#!/usr/bin/env node
/**
 * migrate-firebase.js — move one account's JV data to another Firebase project.
 *
 * JV currently shares a Firebase project with another app. When it outgrows
 * that, this lifts everything across without a console export, a service
 * account, or any downtime beyond the minute it takes to run.
 *
 *   # 1. dump from the project in .env
 *   node scripts/migrate-firebase.js export jv@example.com 'password' > jv-backup.json
 *
 *   # 2. load into the new one
 *   FIREBASE_API_KEY=<new-key> FIREBASE_PROJECT_ID=<new-project> \
 *     node scripts/migrate-firebase.js import jv@example.com 'password' jv-backup.json
 *
 * Both halves run **as the user**, so the same security rules apply and no
 * privileged key is needed at either end. The destination project needs the
 * jv_* rules published and the account created there first:
 *
 *   FIREBASE_API_KEY=… FIREBASE_PROJECT_ID=… node scripts/create-user.js "Name" email
 *
 * The export is also a perfectly good backup on its own — worth running every
 * so often regardless of any move.
 */

import { readFileSync } from 'node:fs';
import { signIn, getDoc, setDoc, listDocuments } from '../src/firebase.js';
import { USERS, CLIENTS, LEDGERS, monthsPath } from '../src/collections.js';

const [, , command, email, password, file] = process.argv;

const usage = () => {
  console.error(
    'Usage:\n' +
      '  node scripts/migrate-firebase.js export <email> <password> > backup.json\n' +
      '  node scripts/migrate-firebase.js import <email> <password> backup.json\n',
  );
  process.exit(1);
};

if (!['export', 'import'].includes(command) || !email || !password) usage();
if (command === 'import' && !file) usage();

/** Console notes go to stderr so `> backup.json` captures only the data. */
const note = (msg) => console.error(msg);

async function runExport(auth) {
  const [profile, clients, ledger] = await Promise.all([
    getDoc(USERS, auth.uid, auth.idToken),
    getDoc(CLIENTS, auth.uid, auth.idToken),
    getDoc(LEDGERS, auth.uid, auth.idToken),
  ]);

  // Read the month documents themselves rather than trusting the index, so a
  // stale summary can never silently drop a month from the backup.
  const months = await listDocuments(monthsPath(auth.uid), { idToken: auth.idToken });

  const entries = months.reduce((n, m) => n + (m.entries?.length || 0), 0);
  note(
    `✓ Exported ${clients?.clients?.length || 0} clients, ` +
      `${entries} entries across ${months.length} months`,
  );

  process.stdout.write(
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        projectId: process.env.FIREBASE_PROJECT_ID,
        uid: auth.uid,
        email,
        profile,
        clients: clients?.clients || [],
        ledgerMonths: ledger?.months || months.map((m) => m.id).sort(),
        months: months.map(({ id, entries: rows }) => ({ id, entries: rows || [] })),
      },
      null,
      2,
    ) + '\n',
  );
}

async function runImport(auth) {
  const data = JSON.parse(readFileSync(file, 'utf8'));

  if (data.uid === auth.uid && data.projectId === process.env.FIREBASE_PROJECT_ID) {
    note('✗ Source and destination are the same project and account — nothing to do.');
    process.exit(1);
  }

  const existing = await getDoc(LEDGERS, auth.uid, auth.idToken);
  if (existing?.months?.length) {
    note(
      `✗ ${email} already has ${existing.months.length} months of ledger data in ` +
        `${process.env.FIREBASE_PROJECT_ID}. Refusing to overwrite it.`,
    );
    process.exit(1);
  }

  await setDoc(
    CLIENTS,
    auth.uid,
    { uid: auth.uid, clients: data.clients || [], updatedAt: new Date() },
    auth.idToken,
  );
  note(`  clients      ${data.clients?.length || 0}`);

  for (const month of data.months || []) {
    await setDoc(
      monthsPath(auth.uid),
      month.id,
      { month: month.id, entries: month.entries || [], updatedAt: new Date() },
      auth.idToken,
    );
    note(`  ${month.id}      ${month.entries?.length || 0} entries`);
  }

  // Written last: until the index exists the ledger reads as empty, so a run
  // that dies halfway leaves nothing half-visible.
  await setDoc(
    LEDGERS,
    auth.uid,
    {
      uid: auth.uid,
      months: (data.months || []).map((m) => m.id).sort(),
      updatedAt: new Date(),
    },
    auth.idToken,
  );

  note(`\n✓ Imported into ${process.env.FIREBASE_PROJECT_ID} as ${email}\n`);
}

async function main() {
  note(`→ ${command} · project ${process.env.FIREBASE_PROJECT_ID} · ${email}`);
  const auth = await signIn(email, password);
  if (command === 'export') await runExport(auth);
  else await runImport(auth);
}

main().catch((e) => {
  note(`\n✗ ${e.message}\n`);
  process.exit(1);
});
