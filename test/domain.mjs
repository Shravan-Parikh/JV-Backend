/**
 * domain.mjs — the arithmetic that must never be wrong.
 *
 * The ledger's whole value is that its figures can be trusted, so the money and
 * weight maths is pinned here rather than left to be noticed in production.
 * Plain assertions, no framework, no dependencies: `npm test`.
 *
 * The worked example running through it is a real one — 100 kg of 150/48 FDY in
 * on lot L-001, 98.5 kg back out, billed at Rs 18/kg plus 5% GST, Rs 1,000 paid
 * on account — so the expected figures can be checked against a calculator.
 */

import { sanitiseEntry, validateEntry, sanitiseClient, validateClient } from '../src/yarn.js';
import { summarise, lots, withRunningBalance, totalsFor } from '../src/ledger.js';

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? '✓' : '✗'} ${label}: got ${JSON.stringify(got)}${ok ? '' : ` want ${JSON.stringify(want)}`}`);
};

const client = { id: 'c1', ...sanitiseClient({ name: 'Shah Textiles', gstin: '26AAAAA0000A1Z5', defaultRate: 18, openingBalance: 0 }) };
eq('client valid', validateClient(client), null);
eq('bad gstin rejected', validateClient({ ...client, gstin: 'NOPE' })?.slice(0, 14), 'That GSTIN doe');

const mk = (o, created) => ({ id: Math.random().toString(36).slice(2), createdAt: created, ...sanitiseEntry(o) });

// Inward 100 kg, lot L-001
const inward = mk({ kind: 'inward', date: '2026-11-01', clientId: 'c1', clientName: 'Shah Textiles',
  lotNo: 'L-001', yarnType: 'poly-fdy', denier: '150/48', shade: 'Raw White',
  grossWeight: 104.5, tareWeight: 4.5, bags: 10, cones: 40, ply: 2, tpm: 600, twist: 'S' }, '2026-11-01T09:00:00Z');
eq('net derived from gross-tare', inward.netWeight, 100);
eq('inward bills nothing', [inward.amount, inward.totalAmount], [0, 0]);
eq('inward valid', validateEntry(inward), null);

// Outward 98.5 kg at Rs 18/kg + 5% GST
const outward = mk({ kind: 'outward', date: '2026-11-08', clientId: 'c1', clientName: 'Shah Textiles',
  lotNo: 'L-001', netWeight: 98.5, bags: 10, cones: 39, ply: 2, tpm: 600, twist: 'S',
  rate: 18, rateUnit: 'per_kg', gstRate: 5 }, '2026-11-08T09:00:00Z');
eq('taxable amount 98.5 x 18', outward.amount, 1773);
eq('gst at 5%', outward.gstAmount, 88.65);
eq('invoice total', outward.totalAmount, 1861.65);

const payment = mk({ kind: 'payment', date: '2026-11-20', clientId: 'c1', clientName: 'Shah Textiles',
  amount: 1000, mode: 'upi', reference: 'UPI/123' }, '2026-11-20T09:00:00Z');
eq('payment valid', validateEntry(payment), null);

const entries = [inward, outward, payment];

const [lot] = lots(entries);
eq('lot inward kg', lot.inwardKg, 100);
eq('lot outward kg', lot.outwardKg, 98.5);
eq('lot balance kg', lot.balanceKg, 1.5);
eq('wastage percent', lot.gapPercent, 1.5);
// 98.5 kg back from 100 kg is a 1.5% loss — that is what twisting costs, not
// 1.5 kg of the client's yarn still sitting here. The lot is finished.
eq('finished lot is complete, not open', [lot.complete, lot.open], [true, false]);
eq('its shortfall is recorded as wastage', lot.wastageKg, 1.5);

const { clients: rows, totals } = summarise(entries, [client]);
eq('nothing of theirs left on the floor', rows[0].materialKg, 0);
eq('and 1.5 kg written off as wastage', rows[0].wastageKg, 1.5);
eq('billed', rows[0].billed, 1861.65);
eq('paid', rows[0].paid, 1000);
eq('client balance', rows[0].balance, 861.65);
eq('totals outstanding', totals.outstanding, 861.65);

const run = withRunningBalance(entries, 0);
eq('running balance after each', run.map((e) => e.runningBalance), [0, 1861.65, 861.65]);

// Opening balance carries into the statement
const withOpening = withRunningBalance(entries, 5000);
eq('opening balance carried', withOpening[2].runningBalance, 5861.65);

const t = totalsFor(entries);
eq('slice totals', [t.inwardKg, t.outwardKg, t.billed, t.gst, t.paid], [100, 98.5, 1861.65, 88.65, 1000]);

// A lot still genuinely short — 300 of 1000 kg delivered — is open, and its
// 700 kg is the client's yarn still on JV's floor.
const partial = [
  mk({ kind: 'inward', date: '2026-11-05', clientId: 'c1', clientName: 'Shah Textiles', lotNo: 'L-PART', netWeight: 1000 }, '2026-11-05T09:00:00Z'),
  mk({ kind: 'outward', date: '2026-11-09', clientId: 'c1', clientName: 'Shah Textiles', lotNo: 'L-PART', netWeight: 300, rate: 18, gstRate: 5 }, '2026-11-09T09:00:00Z'),
];
const openLot = lots(partial)[0];
eq('part-delivered lot stays open', [openLot.open, openLot.complete], [true, false]);
eq('its balance is the yarn still here', openLot.balanceKg, 700);
eq('and it counts as material with us', summarise(partial, [client]).clients[0].materialKg, 700);

// Trading material is JV's own stock, so it must never count as a client's.
const trade = mk({ kind: 'inward', date: '2026-11-02', clientId: 'c1', clientName: 'Shah Textiles',
  account: 'trading', netWeight: 50, lotNo: 'T-9' }, '2026-11-02T09:00:00Z');
eq('trading adds nothing to client material', summarise([...partial, trade], [client]).clients[0].materialKg, 700);

// Ordering. An outward dated before the inward that supplied it drives the
// running material balance negative on the way through, which is legitimate —
// the figure that matters is where it lands. Clamping the intermediate to zero
// silently discards everything subtracted so far, and the only symptom is a
// material balance that is quietly too high.
const early = mk({ kind: 'outward', date: '2026-11-02', clientId: 'c1', clientName: 'Shah Textiles',
  lotNo: 'L-002', netWeight: 39.2, rate: 18, gstRate: 5 }, '2026-11-02T09:00:00Z');
const late = mk({ kind: 'inward', date: '2026-12-03', clientId: 'c1', clientName: 'Shah Textiles',
  lotNo: 'L-002', netWeight: 400 }, '2026-12-03T09:00:00Z');
// Walked in date order the running total goes 100 → 60.8 → -37.7 → 362.3, so it
// is negative in the middle. Less L-001's 1.5 kg of wastage, 360.8 kg remain.
const ooo = summarise([...entries, early, late], [client]);
eq('material balance survives out-of-order entries', ooo.clients[0].materialKg, 360.8);
eq('and its totals agree', ooo.totals.materialKg, 360.8);
eq('inward total unaffected', ooo.clients[0].inwardKg, 500);
eq('outward total unaffected', ooo.clients[0].outwardKg, 137.7);
eq('open lot balances agree with the material balance',
  lots([...entries, early, late]).filter((l) => l.open).reduce((n, l) => Math.round((n + l.balanceKg) * 1000) / 1000, 0), 360.8);

// A client who has had more delivered than they sent is in material credit, and
// that must show as a negative rather than being floored at zero.
const over = mk({ kind: 'outward', date: '2026-12-20', clientId: 'c1', clientName: 'Shah Textiles',
  lotNo: 'L-003', netWeight: 10 }, '2026-12-20T09:00:00Z');
eq('over-delivery shows as negative material', summarise([over], [client]).clients[0].materialKg, -10);

// Float drift. In plain IEEE arithmetic 0.1 + 0.2 is 0.30000000000000004 and
// three ten-paise amounts do not sum to thirty paise; rounding at each boundary
// is what keeps a printed statement adding up.
const dimes = Array.from({ length: 3 }, (_, i) => mk({ kind: 'outward', date: '2026-11-10',
  clientId: 'c1', clientName: 'X', netWeight: 0.1, rate: 1, gstRate: 0 }, `2026-11-10T00:00:0${i}Z`));
eq('three ten-paise amounts sum cleanly', totalsFor(dimes).billed, 0.3);
eq('weights accumulate cleanly', totalsFor(dimes).outwardKg, 0.3);

// Rounding happens per entry, by design: 0.333 kg at Rs 3 is Rs 0.999, which is
// a rupee on an invoice, so a hundred of them is Rs 100 and not Rs 99.90.
const many = Array.from({ length: 100 }, (_, i) => mk({ kind: 'outward', date: '2026-11-10',
  clientId: 'c1', clientName: 'X', netWeight: 0.333, rate: 3, gstRate: 0 }, `2026-11-10T00:00:${String(i).padStart(2,'0')}Z`));
eq('each entry rounds to the paise', totalsFor(many).billed, 100);

// Validation guards
eq('rejects missing client', validateEntry(sanitiseEntry({ kind: 'inward', date: '2026-11-01', netWeight: 5 })), 'Choose a client');
eq('rejects zero weight', validateEntry(sanitiseEntry({ kind: 'inward', date: '2026-11-01', clientId: 'c1', clientName: 'X' }))?.startsWith('Enter a net weight'), true);
eq('rejects tare > gross', validateEntry(sanitiseEntry({ kind: 'inward', date: '2026-11-01', clientId: 'c1', clientName: 'X', netWeight: 5, grossWeight: 10, tareWeight: 12 })), 'Tare weight cannot be more than gross weight');
eq('rejects zero payment', validateEntry(sanitiseEntry({ kind: 'payment', date: '2026-11-01', clientId: 'c1', clientName: 'X', amount: 0 })), 'Enter the amount received');
eq('negative weight ignored', sanitiseEntry({ kind: 'inward', date: '2026-11-01', clientId: 'c1', clientName: 'X', netWeight: -5 }).netWeight, 0);
eq('per-cone rate basis', sanitiseEntry({ kind: 'outward', date: '2026-11-01', clientId: 'c1', clientName: 'X', netWeight: 10, cones: 40, rate: 5, rateUnit: 'per_cone', gstRate: 0 }).amount, 200);
eq('explicit amount beats computed', sanitiseEntry({ kind: 'outward', date: '2026-11-01', clientId: 'c1', clientName: 'X', netWeight: 98.5, rate: 18, amount: 1750, gstRate: 0 }).amount, 1750);

console.log(fails ? `\n${fails} FAILED` : '\nAll domain checks passed');
process.exit(fails ? 1 : 0);
