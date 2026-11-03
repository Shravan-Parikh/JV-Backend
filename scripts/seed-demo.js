#!/usr/bin/env node
/**
 * seed-demo.js — fill an account with realistic demo data, and take it out again.
 *
 *   node scripts/seed-demo.js <email> <password>            # add
 *   node scripts/seed-demo.js <email> <password> --remove   # take it all out
 *
 * For showing someone how the app behaves before they trust it with real work.
 * Everything here is invented: the firms, the GSTINs, the lorry numbers. The
 * shapes are the real ones though — Silvassa and the Vapi–Surat belt, polyester
 * filament and spun viscose, job-work rates of ₹15–26 a kilo, and wastage
 * between 0.8% and 2%, which is what twisting actually loses.
 *
 * `--remove` deletes **every client and every entry on the account**, not just
 * the ones this script wrote, because that is what makes it trustworthy as a
 * "put it back how you found it" button. It refuses to run if the account holds
 * anything the seeder did not create, so it cannot quietly eat real work.
 *
 * Writes go through the API, so the data obeys exactly the same validation and
 * arithmetic as anything typed into the form.
 */

import { signIn, getDoc, setDoc, deleteDoc, listDocuments } from '../src/firebase.js';
import { LEDGERS, monthsPath } from '../src/collections.js';

const [, , email, password, ...flags] = process.argv;
const REMOVE = flags.includes('--remove');
const API = process.env.JV_API_BASE || 'http://localhost:4100/api';

if (!email || !password) {
  console.error('Usage: node scripts/seed-demo.js <email> <password> [--remove]');
  console.error('       JV_API_BASE=https://…/api to point at a deployed API');
  process.exit(1);
}

/** Everything this script writes carries this, so removal can be sure. */
const MARK = 'demo-data';

let TOKEN = '';

async function call(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) },
  });
  const text = await res.text();
  const data = text.startsWith('{') ? JSON.parse(text) : text;
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${data?.error || text.slice(0, 120)}`);
  return data;
}

const kg = (n) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------
// The cast
// ---------------------------------------------------------------------------
//
// State codes in the GSTINs are real: 26 is Dadra & Nagar Haveli and Daman &
// Diu, 24 is Gujarat. The rest of each number is invented.

const CLIENTS = [
  { key: 'shah',    name: 'Shah Textiles',             contactPerson: 'Nilesh Shah',    phone: '98250 41122', city: 'Silvassa', state: 'Dadra & Nagar Haveli', gstin: '26AABCS1429K1Z7', defaultRate: 18, defaultGstRate: 5, address: 'Plot 22, Masat Industrial Estate' },
  { key: 'balaji',  name: 'Balaji Synthetics',         contactPerson: 'Ramesh Agarwal', phone: '99043 77810', city: 'Vapi',     state: 'Gujarat',              gstin: '24AADCB7712M1ZB', defaultRate: 22, defaultGstRate: 5, address: 'GIDC Phase II, Char Rasta' },
  { key: 'krishna', name: 'Krishna Fabrics',           contactPerson: 'Jignesh Patel',  phone: '98792 30145', city: 'Surat',    state: 'Gujarat',              gstin: '24AAECK9065P1ZQ', defaultRate: 16, defaultGstRate: 5, address: 'Shed 14, Pandesara GIDC', openingBalance: 18500, openingBalanceDate: '2026-08-31' },
  { key: 'ambica',  name: 'Ambica Yarn Agency',        contactPerson: 'Dilip Bhai',     phone: '94280 66201', city: 'Silvassa', state: 'Dadra & Nagar Haveli', gstin: '26AAGFA3318L1ZD', defaultRate: 20, defaultGstRate: 5, address: 'Near Piparia Chowk' },
  { key: 'ganesh',  name: 'Shree Ganesh Textiles',     contactPerson: 'Mahesh Joshi',   phone: '99789 12043', city: 'Daman',    state: 'Daman & Diu',          gstin: '26AAHCS5521J1ZM', defaultRate: 24, defaultGstRate: 5, address: 'Kachigam Industrial Area' },
  { key: 'laxmi',   name: 'Laxmi Narayan Weaving',     contactPerson: 'Suresh Mittal',  phone: '98253 88190', city: 'Surat',    state: 'Gujarat',              gstin: '24AAJCL2204N1ZX', defaultRate: 17, defaultGstRate: 5, address: 'Katargam, Ved Road' },
  { key: 'patel',   name: 'Patel Twisters & Traders',  contactPerson: 'Hiren Patel',    phone: '90990 45512', city: 'Vapi',     state: 'Gujarat',              gstin: '24AAKFP6680R1ZE', defaultRate: 19, defaultGstRate: 5, address: 'Gunjan Char Rasta' },
  { key: 'maruti',  name: 'Maruti Polyfab',            contactPerson: 'Ashok Desai',    phone: '94265 33471', city: 'Silvassa', state: 'Dadra & Nagar Haveli', gstin: '26AALCM1176H1ZK', defaultRate: 21, defaultGstRate: 5, address: 'Dadra Industrial Estate' },
  { key: 'jayambe', name: 'Jay Ambe Enterprises',      contactPerson: 'Kiran Solanki',  phone: '97129 54608', city: 'Bhilad',   state: 'Gujarat',              gstin: '24AAMFJ8834T1ZG', defaultRate: 15, defaultGstRate: 5, address: 'NH-48 Service Road' },
  { key: 'rajhans', name: 'Rajhans Synthetics',        contactPerson: 'Vipul Zaveri',   phone: '98982 70033', city: 'Surat',    state: 'Gujarat',              gstin: '24AANCR4417W1ZP', defaultRate: 26, defaultGstRate: 5, address: 'Sachin GIDC, Plot 61' },
];

const VEHICLES = ['GJ 05 BX 4412', 'DD 01 C 7788', 'GJ 15 AT 2290', 'MH 48 BK 6611', 'DD 03 A 1205', 'GJ 21 CQ 8834'];
const TRANSPORTERS = ['V-Trans India', 'Gati Logistics', 'Shree Maruti Courier', 'Patel Roadways', 'Vijay Transport'];

/**
 * One lot: what came in, and what went back out against it.
 *
 * `wastage` is the fraction lost in process. Where it is null the lot is still
 * open — the yarn is on the floor and nothing has been delivered yet.
 */
const LOTS = [
  // Shah Textiles — the big regular. Two lots closed, one still running.
  { client: 'shah', lot: 'ST-1109', date: '2026-09-08', yarn: 'poly-fdy', denier: '150/48', shade: 'Raw White', ply: 2, tpm: 600, twist: 'S', bags: 24, cones: 96, inward: 612.4, wastage: 0.012, outDate: '2026-09-16', rate: 18 },
  { client: 'shah', lot: 'ST-1114', date: '2026-10-02', yarn: 'poly-fdy', denier: '150/48', shade: 'Raw White', ply: 2, tpm: 600, twist: 'S', bags: 30, cones: 120, inward: 780.0, wastage: 0.015, outDate: '2026-10-11', rate: 18 },
  { client: 'shah', lot: 'ST-1121', date: '2026-10-27', yarn: 'poly-dty', denier: '300/96', shade: 'Semi Dull', ply: 2, tpm: 450, twist: 'Z', bags: 18, cones: 72, inward: 455.8, wastage: null, rate: 18, partials: [{ date: '2026-11-01', kg: 200.0 }] },

  // Balaji Synthetics — settles on time, nothing outstanding.
  { client: 'balaji', lot: 'BS-77', date: '2026-09-14', yarn: 'poly-fdy', denier: '75/36', shade: 'Bright', ply: 3, tpm: 800, twist: 'S', bags: 16, cones: 80, inward: 318.25, wastage: 0.009, outDate: '2026-09-22', rate: 22 },
  { client: 'balaji', lot: 'BS-83', date: '2026-10-06', yarn: 'poly-fdy', denier: '75/36', shade: 'Bright', ply: 3, tpm: 800, twist: 'S', bags: 20, cones: 100, inward: 402.5, wastage: 0.011, outDate: '2026-10-15', rate: 22 },

  // Krishna Fabrics — a large lot only just received, plus an old balance.
  { client: 'krishna', lot: 'KF-2201', date: '2026-10-29', yarn: 'viscose', denier: '150/40', shade: 'Dyed', ply: 2, tpm: 500, twist: 'S', bags: 40, cones: 160, inward: 1248.6, wastage: null, rate: 16 },

  // Ambica — one closed, one delivered in two parts and still short.
  { client: 'ambica', lot: 'AY-410', date: '2026-09-19', yarn: 'poly-spun', denier: '2/30s', shade: 'Raw White', ply: 2, tpm: 700, twist: 'Z', bags: 22, cones: 88, inward: 548.9, wastage: 0.013, outDate: '2026-09-28', rate: 20 },
  { client: 'ambica', lot: 'AY-418', date: '2026-10-20', yarn: 'poly-spun', denier: '2/30s', shade: 'Raw White', ply: 2, tpm: 700, twist: 'Z', bags: 26, cones: 104, inward: 650.0, wastage: null, rate: 20, partials: [{ date: '2026-10-28', kg: 300.0 }] },

  // Shree Ganesh — paid more than billed, so sits in credit.
  { client: 'ganesh', lot: 'SG-56', date: '2026-09-25', yarn: 'poly-dty', denier: '150/48', shade: 'Melange', ply: 2, tpm: 900, twist: 'S', bags: 14, cones: 56, inward: 286.75, wastage: 0.018, outDate: '2026-10-03', rate: 24 },

  // Laxmi Narayan — steady monthly work.
  { client: 'laxmi', lot: 'LN-901', date: '2026-09-11', yarn: 'poly-fdy', denier: '150/48', shade: 'Raw White', ply: 2, tpm: 550, twist: 'S', bags: 28, cones: 112, inward: 702.3, wastage: 0.010, outDate: '2026-09-20', rate: 17 },
  { client: 'laxmi', lot: 'LN-915', date: '2026-10-13', yarn: 'poly-fdy', denier: '150/48', shade: 'Raw White', ply: 2, tpm: 550, twist: 'S', bags: 32, cones: 128, inward: 812.0, wastage: 0.012, outDate: '2026-10-23', rate: 17 },

  // Patel Twisters — JV's own material, bought and sold on its own account.
  { client: 'patel', lot: 'OWN-12', date: '2026-10-08', yarn: 'poly-fdy', denier: '150/48', shade: 'Raw White', ply: 2, tpm: 600, twist: 'S', bags: 20, cones: 80, inward: 500.0, wastage: 0.014, outDate: '2026-10-18', rate: 72, account: 'trading' },

  // Maruti Polyfab — nylon, still on the floor.
  { client: 'maruti', lot: 'MP-330', date: '2026-10-24', yarn: 'nylon', denier: '70/24', shade: 'Raw White', ply: 2, tpm: 1100, twist: 'Z', bags: 12, cones: 60, inward: 215.4, wastage: null, rate: 21 },

  // Jay Ambe — spun viscose, coarse count, low rate.
  { client: 'jayambe', lot: 'JA-88', date: '2026-09-29', yarn: 'viscose-spun', denier: '2/20s', shade: 'Raw White', ply: 2, tpm: 420, twist: 'S', bags: 34, cones: 136, inward: 905.6, wastage: 0.016, outDate: '2026-10-08', rate: 15 },
  { client: 'jayambe', lot: 'JA-94', date: '2026-10-21', yarn: 'viscose-spun', denier: '2/20s', shade: 'Raw White', ply: 2, tpm: 420, twist: 'S', bags: 30, cones: 120, inward: 798.2, wastage: 0.014, outDate: '2026-10-30', rate: 15 },

  // This month's work — a lot turned round inside three days, and two more in.
  { client: 'balaji', lot: 'BS-91', date: '2026-10-31', yarn: 'poly-fdy', denier: '75/36', shade: 'Bright', ply: 3, tpm: 800, twist: 'S', bags: 18, cones: 90, inward: 364.8, wastage: 0.010, outDate: '2026-11-03', rate: 22 },
  { client: 'laxmi', lot: 'LN-928', date: '2026-11-02', yarn: 'poly-fdy', denier: '150/48', shade: 'Raw White', ply: 2, tpm: 550, twist: 'S', bags: 26, cones: 104, inward: 668.5, wastage: null, rate: 17 },
  { client: 'ganesh', lot: 'SG-61', date: '2026-11-03', yarn: 'poly-dty', denier: '150/48', shade: 'Dyed', ply: 2, tpm: 900, twist: 'S', bags: 16, cones: 64, inward: 332.9, wastage: null, rate: 24 },

  // Rajhans — fine denier, high rate, invoice still unpaid.
  { client: 'rajhans', lot: 'RS-507', date: '2026-10-16', yarn: 'poly-fdy', denier: '50/24', shade: 'Cationic', ply: 3, tpm: 1200, twist: 'S', bags: 10, cones: 50, inward: 184.35, wastage: 0.008, outDate: '2026-10-26', rate: 26 },
];

/** Money in. Deliberately uneven — part payments, round figures, one advance. */
const PAYMENTS = [
  { client: 'shah',    date: '2026-09-30', amount: 10000, mode: 'neft',   reference: 'NEFT/SBIN/8841920' },
  { client: 'shah',    date: '2026-10-22', amount: 12000, mode: 'rtgs',   reference: 'RTGS/HDFC/5520177' },
  { client: 'balaji',  date: '2026-09-30', amount: 7350,  mode: 'neft',   reference: 'NEFT/ICIC/3390281' },
  { client: 'balaji',  date: '2026-10-24', amount: 9200,  mode: 'upi',    reference: 'UPI/428810457733' },
  { client: 'krishna', date: '2026-10-05', amount: 10000, mode: 'cheque', reference: 'CHQ 114207 · BoB' },
  { client: 'ambica',  date: '2026-10-09', amount: 11000, mode: 'neft',   reference: 'NEFT/AXIS/7710433' },
  { client: 'ganesh',  date: '2026-10-12', amount: 9000,  mode: 'rtgs',   reference: 'RTGS/KOTK/2219806' },
  { client: 'laxmi',   date: '2026-09-29', amount: 12500, mode: 'neft',   reference: 'NEFT/SBIN/9014772' },
  { client: 'laxmi',   date: '2026-10-28', amount: 14000, mode: 'neft',   reference: 'NEFT/SBIN/9118340' },
  { client: 'patel',   date: '2026-10-26', amount: 25000, mode: 'rtgs',   reference: 'RTGS/HDFC/6640218' },
  { client: 'jayambe', date: '2026-10-14', amount: 13000, mode: 'cash',   reference: 'Cash — collected at unit' },
  { client: 'jayambe', date: '2026-11-01', amount: 10000, mode: 'upi',    reference: 'UPI/501227883914' },
  { client: 'rajhans', date: '2026-11-02', amount: 5000,  mode: 'upi',    reference: 'UPI/512908447120' },
  { client: 'shah',    date: '2026-11-03', amount: 15000, mode: 'neft',   reference: 'NEFT/SBIN/9220614' },
];

// ---------------------------------------------------------------------------

async function seed() {
  const existing = await call('/entries');
  const existingClients = await call('/clients');
  const foreign =
    existing.entries.some((e) => e.notes !== MARK) ||
    existingClients.clients.some((c) => c.notes !== MARK);

  if (foreign) {
    console.error(
      `\n✗ This account already holds data the seeder did not write ` +
        `(${existingClients.clients.length} clients, ${existing.entries.length} entries).\n` +
        `  Refusing to add demo data on top of real work.\n`,
    );
    process.exit(1);
  }
  if (existing.entries.length) {
    console.error('\n✗ Demo data is already loaded. Remove it first:\n  … --remove\n');
    process.exit(1);
  }

  console.log(`\nSeeding ${API}\n`);

  const ids = {};
  for (const c of CLIENTS) {
    const { key, ...fields } = c;
    const r = await call('/clients', { method: 'POST', body: JSON.stringify({ ...fields, notes: MARK }) });
    ids[key] = r.client.id;
    console.log(`  client   ${c.name}`);
  }

  let n = 0;
  const pick = (arr, i) => arr[i % arr.length];

  // Entries are written oldest-first so the ledger reads the way it was lived.
  const queue = [];

  LOTS.forEach((l, i) => {
    const common = {
      clientId: ids[l.client],
      clientName: CLIENTS.find((c) => c.key === l.client).name,
      account: l.account || 'jobwork',
      lotNo: l.lot,
      yarnType: l.yarn,
      denier: l.denier,
      shade: l.shade,
      ply: l.ply,
      tpm: l.tpm,
      twist: l.twist,
      packing: 'bags',
      notes: MARK,
    };

    queue.push({
      ...common,
      kind: 'inward',
      date: l.date,
      bags: l.bags,
      cones: l.cones,
      netWeight: l.inward,
      partyChallanNo: `DC-${4200 + i * 7}`,
      vehicleNo: pick(VEHICLES, i),
      transporter: pick(TRANSPORTERS, i),
      lrNo: `LR-${90110 + i * 13}`,
    });

    // A part delivery, where the lot has one.
    for (const [j, p] of (l.partials || []).entries()) {
      queue.push({
        ...common,
        kind: 'outward',
        date: p.date,
        bags: Math.round((l.bags * p.kg) / l.inward),
        cones: Math.round((l.cones * p.kg) / l.inward),
        netWeight: p.kg,
        challanNo: `JV-${1500 + i * 9 + j}`,
        rate: l.rate,
        rateUnit: 'per_kg',
        gstRate: 5,
        vehicleNo: pick(VEHICLES, i + 2),
        transporter: pick(TRANSPORTERS, i + 1),
        lrNo: `LR-${90400 + i * 11 + j}`,
      });
    }

    // The closing delivery, where the lot is finished.
    if (l.wastage !== null) {
      queue.push({
        ...common,
        kind: 'outward',
        date: l.outDate,
        bags: l.bags,
        cones: l.cones - Math.round(l.cones * 0.02),
        netWeight: kg(l.inward * (1 - l.wastage)),
        challanNo: `JV-${1600 + i * 9}`,
        rate: l.rate,
        rateUnit: 'per_kg',
        gstRate: 5,
        vehicleNo: pick(VEHICLES, i + 3),
        transporter: pick(TRANSPORTERS, i + 2),
        lrNo: `LR-${90700 + i * 17}`,
      });
    }
  });

  for (const p of PAYMENTS) {
    queue.push({
      kind: 'payment',
      date: p.date,
      clientId: ids[p.client],
      clientName: CLIENTS.find((c) => c.key === p.client).name,
      account: 'jobwork',
      amount: p.amount,
      mode: p.mode,
      reference: p.reference,
      notes: MARK,
    });
  }

  queue.sort((a, b) => a.date.localeCompare(b.date));

  // Sequential on purpose: every write is a read-modify-write on one month
  // document, so firing these in parallel would lose entries.
  for (const entry of queue) {
    await call('/entries', { method: 'POST', body: JSON.stringify(entry) });
    n += 1;
    if (n % 10 === 0) console.log(`  entries  ${n}/${queue.length}`);
  }

  const sum = await call('/ledger/summary');
  console.log(`\n✓ ${CLIENTS.length} clients, ${n} entries`);
  console.log(`  outstanding     ₹${sum.totals.outstanding.toLocaleString('en-IN')}`);
  console.log(`  material with us ${sum.totals.materialKg.toLocaleString('en-IN')} kg`);
  console.log(`  open lots        ${sum.openLots.length}`);
  console.log(`\n  Remove it all with:  … --remove\n`);
}

async function remove() {
  const { entries } = await call('/entries');
  const { clients } = await call('/clients');

  const foreign =
    entries.filter((e) => e.notes !== MARK).length + clients.filter((c) => c.notes !== MARK).length;
  if (foreign) {
    console.error(
      `\n✗ ${foreign} record(s) on this account were not written by the seeder.\n` +
        `  Refusing to delete, so real work cannot be lost by accident.\n`,
    );
    process.exit(1);
  }

  console.log(`\nRemoving ${entries.length} entries and ${clients.length} clients…`);
  for (const e of entries) await call(`/entries/${e.id}?date=${e.date}`, { method: 'DELETE' });
  for (const c of clients) await call(`/clients/${c.id}`, { method: 'DELETE' });

  // Deleting entries empties the month documents but leaves them behind, along
  // with an index still naming them. Harmless — they read as empty — but it
  // means every later read opens months that hold nothing, and "put it back how
  // you found it" should mean exactly that.
  const months = await listDocuments(monthsPath(auth.uid), { idToken: auth.idToken });
  const emptied = [];
  for (const m of months) {
    if ((m.entries || []).length === 0) {
      await deleteDoc(monthsPath(auth.uid), m.id, auth.idToken);
      emptied.push(m.id);
    }
  }
  if (emptied.length) {
    const ledger = await getDoc(LEDGERS, auth.uid, auth.idToken);
    const left = (ledger?.months || []).filter((m) => !emptied.includes(m));
    if (left.length) {
      await setDoc(LEDGERS, auth.uid, { uid: auth.uid, months: left, updatedAt: new Date() }, auth.idToken);
    } else {
      await deleteDoc(LEDGERS, auth.uid, auth.idToken);
    }
    console.log(`  cleared ${emptied.length} empty month document(s): ${emptied.join(', ')}`);
  }

  const after = await call('/ledger/summary');
  console.log(
    `\n✓ Account is empty — ${after.totals.entries} entries, ` +
      `₹${after.totals.outstanding} outstanding, ${after.totals.materialKg} kg on the floor\n`,
  );
}

const auth = await signIn(email, password);
TOKEN = auth.idToken;
await (REMOVE ? remove() : seed());
