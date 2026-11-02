/**
 * e2e.mjs — drives the running API the way the app does.
 *
 * Needs the server up and an account to sign in with:
 *
 *   node test/e2e.mjs <email> <password>
 *
 * It writes real entries, so point it at a throwaway account, never the one the
 * business uses. The worked example is the same one in domain.mjs: 100 kg in on
 * lot L-001, 98.5 kg back out at Rs 18/kg plus 5% GST, Rs 1,000 paid.
 *
 * What it is really here to catch is the month partitioning — an entry whose
 * date is edited across a month boundary has to move between two documents
 * without being duplicated or lost, and that is not something the pure domain
 * tests can see.
 */

const API = 'http://localhost:4100/api';
const [EMAIL, PASSWORD] = process.argv.slice(2);
let TOKEN = '';
let fails = 0;

const call = async (path, opts = {}) => {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(opts.headers||{}) },
  });
  const text = await res.text();
  const data = text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text;
  if (!res.ok) throw new Error(`${path} ${res.status}: ${data?.error || text.slice(0,120)}`);
  return data;
};
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
};

const session = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
TOKEN = session.token;
console.log('✓ logged in as', session.user.email, '· role', session.user.role);

const ref = await call('/reference');
eq('reference yarn types', ref.yarnTypes.length > 10, true);
eq('reference default gst', ref.defaultGstRate, 5);

// --- Client ---
const { client } = await call('/clients', { method: 'POST', body: JSON.stringify({
  name: 'Shah Textiles', city: 'Silvassa', phone: '9876543210',
  gstin: '26AAAAA0000A1Z5', defaultRate: 18, defaultGstRate: 5 }) });
console.log('✓ created client', client.name, client.id);

const dupe = await call('/clients', { method: 'POST', body: JSON.stringify({ name: '  shah   textiles ' }) });
eq('duplicate name folded to existing', dupe.duplicate === true && dupe.client.id === client.id, true);

try { await call('/clients', { method: 'POST', body: JSON.stringify({ name: 'Bad GST Co', gstin: 'NOTAGSTIN' }) }); eq('bad gstin rejected', 'accepted', 'rejected'); }
catch (e) { eq('bad gstin rejected', e.message.includes('GSTIN'), true); }

// --- Inward 100 kg ---
const inward = (await call('/entries', { method: 'POST', body: JSON.stringify({
  kind: 'inward', date: '2026-11-01', clientId: client.id, clientName: client.name,
  lotNo: 'L-001', partyChallanNo: 'DC-5521', yarnType: 'poly-fdy', denier: '150/48',
  shade: 'Raw White', ply: 2, tpm: 600, twist: 'S',
  bags: 10, cones: 40, grossWeight: 104.5, tareWeight: 4.5, vehicleNo: 'dd01ab1234' }) })).entry;
eq('inward net = gross - tare', inward.netWeight, 100);
eq('vehicle uppercased', inward.vehicleNo, 'DD01AB1234');
eq('inward bills nothing', inward.totalAmount, 0);

// --- Outward 98.5 kg @ 18 + 5% ---
const outward = (await call('/entries', { method: 'POST', body: JSON.stringify({
  kind: 'outward', date: '2026-11-08', clientId: client.id, clientName: client.name,
  lotNo: 'L-001', challanNo: 'JV-101', netWeight: 98.5, bags: 10, cones: 39,
  ply: 2, tpm: 600, twist: 'S', rate: 18, rateUnit: 'per_kg', gstRate: 5 }) })).entry;
eq('taxable amount', outward.amount, 1773);
eq('gst amount', outward.gstAmount, 88.65);
eq('invoice total', outward.totalAmount, 1861.65);

// --- Lot / wastage ---
const list = await call('/entries');
const lot = list.lots.find((l) => l.lotNo === 'L-001');
eq('lot balance kg', lot.balanceKg, 1.5);
eq('wastage percent', lot.gapPercent, 1.5);
eq('lot still open', lot.open, true);

// --- Payment ---
await call('/entries', { method: 'POST', body: JSON.stringify({
  kind: 'payment', date: '2026-11-20', clientId: client.id, clientName: client.name,
  amount: 1000, mode: 'upi', reference: 'UPI/99887' }) });

// --- Summary ---
const sum = await call('/ledger/summary');
eq('material with us', sum.totals.materialKg, 1.5);
eq('outstanding', sum.totals.outstanding, 861.65);
eq('client balance', sum.clients[0].balance, 861.65);
eq('open lots', sum.openLots.length, 1);

// --- Statement ---
const st = await call(`/ledger/statement?client=${client.id}`);
eq('statement running balances', st.entries.map((e) => e.runningBalance), [0, 1861.65, 861.65]);
eq('closing balance', st.closingBalance, 861.65);

// --- Cross-month: an entry in another month, and the month index ---
await call('/entries', { method: 'POST', body: JSON.stringify({
  kind: 'inward', date: '2026-12-03', clientId: client.id, clientName: client.name,
  lotNo: 'L-002', netWeight: 40 }) });
eq('both months readable', (await call('/entries')).entries.length, 4);
eq('december only', (await call('/entries?from=2026-12-01&to=2026-12-31')).entries.length, 1);
eq('november only', (await call('/entries?from=2026-11-01&to=2026-11-30')).entries.length, 3);

// --- Filters ---
eq('filter by kind', (await call('/entries?kind=outward')).entries.length, 1);
eq('filter by lot', (await call('/entries?lot=L-001')).entries.length, 2);
eq('search by challan', (await call('/entries?q=DC-5521')).entries.length, 1);
eq('search by vehicle', (await call('/entries?q=dd01ab')).entries.length, 1);

// --- Edit moves an entry across months ---
const moved = (await call(`/entries/${inward.id}`, { method: 'PATCH', body: JSON.stringify({ date: '2026-12-15', currentDate: '2026-11-01' }) })).entry;
eq('entry moved month', moved.date, '2026-12-15');
eq('november now has 2', (await call('/entries?from=2026-11-01&to=2026-11-30')).entries.length, 2);
eq('december now has 2', (await call('/entries?from=2026-12-01&to=2026-12-31')).entries.length, 2);
eq('nothing lost in the move', (await call('/entries')).entries.length, 4);
eq('fields survived the move', [moved.lotNo, moved.netWeight, moved.denier], ['L-001', 100, '150/48']);
// put it back
await call(`/entries/${inward.id}`, { method: 'PATCH', body: JSON.stringify({ date: '2026-11-01', currentDate: '2026-12-15' }) });

// --- A rejected edit must not corrupt the stored entry ---
try { await call(`/entries/${outward.id}`, { method: 'PATCH', body: JSON.stringify({ netWeight: 0, currentDate: '2026-11-08' }) }); eq('zero-weight edit rejected', 'accepted', 'rejected'); }
catch (e) { eq('zero-weight edit rejected', e.message.includes('net weight'), true); }
eq('entry untouched after rejected edit', (await call('/entries?lot=L-001')).entries.find((e) => e.id === outward.id).netWeight, 98.5);

// --- Deleting a client with entries deactivates instead ---
const del = await call(`/clients/${client.id}`, { method: 'DELETE' });
eq('client deactivated not deleted', del.deactivated, true);
eq('client still in list', del.clients.length, 1);
await call(`/clients/${client.id}`, { method: 'PATCH', body: JSON.stringify({ active: true }) });

// --- CSV ---
const csvRes = await fetch(`${API}/export/ledger.csv?client=${client.id}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
// Read the bytes, not the text: fetch's UTF-8 decode strips a leading BOM, so
// `.text()` cannot tell you whether Excel will get the one it needs.
const bytes = Buffer.from(await csvRes.arrayBuffer());
eq('csv starts with a UTF-8 BOM', [...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
const csv = bytes.toString('utf8').replace(/^\uFEFF/, '');
const lines = csv.trim().split('\r\n');
eq('csv has a row per entry plus header', lines.length, 5);
eq('csv carries the invoice total', lines.some((l) => l.includes('1861.65')), true);
eq('csv carries the running balance', lines.some((l) => l.endsWith('861.65')), true);

console.log('\ncsv header:', lines[0].slice(0, 110), '…');
console.log(fails ? `\n${fails} FAILED` : '\nAll end-to-end checks passed');
process.exit(fails ? 1 : 0);
