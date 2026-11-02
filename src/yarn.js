/**
 * yarn.js — the vocabulary of a twisting unit, and the arithmetic on an entry.
 *
 * Twisting is job work: a client sends grey yarn on their own delivery challan,
 * JV adds ply and twist, and returns it on JV's challan with a bill for the
 * processing charge per kg. JV never owns that material. So an entry has to
 * carry enough to answer, months later and without argument:
 *
 *   - whose yarn is this, which lot, and what was it (type, denier, shade)
 *   - what was asked of it (ply, twists per metre, S or Z)
 *   - how much came in and how much went back (gross / tare / net, bags, cones)
 *   - what it was billed at, and what has been paid against it
 *
 * JV also buys and sells on its own account, which is the same paperwork with a
 * different meaning for the money — so every entry carries an `account` of
 * `jobwork` (billing a processing charge) or `trading` (billing goods).
 *
 * Nothing here touches Firestore. It takes an untrusted object off the wire and
 * returns a clean one, so routes stay thin and the same rules apply to a create,
 * an edit and an import.
 */

import { config } from './config.js';

// ---------------------------------------------------------------------------
// Reference data — served to the client so the form's dropdowns and the
// server's validation can never drift apart.
// ---------------------------------------------------------------------------

export const ENTRY_KINDS = [
  { id: 'inward', label: 'Inward', hint: 'Material received from a client' },
  { id: 'outward', label: 'Outward', hint: 'Processed material delivered back' },
  { id: 'payment', label: 'Payment', hint: 'Money received from a client' },
];

export const ACCOUNTS = [
  { id: 'jobwork', label: 'Job work', hint: "Client's material — JV bills the twisting charge" },
  { id: 'trading', label: 'Own trading', hint: "JV's own material — JV bills the goods" },
];

/**
 * Filament yarns are specified in denier, spun yarns in count (Ne). Both are
 * free text on the entry because the trade writes them many ways ('150/48',
 * '2/30s'), but the type drives which label the form shows.
 */
export const YARN_TYPES = [
  { id: 'poly-fdy', label: 'Polyester FDY', spec: 'denier' },
  { id: 'poly-poy', label: 'Polyester POY', spec: 'denier' },
  { id: 'poly-dty', label: 'Polyester DTY', spec: 'denier' },
  { id: 'poly-spun', label: 'Polyester Spun', spec: 'count' },
  { id: 'viscose', label: 'Viscose', spec: 'denier' },
  { id: 'viscose-spun', label: 'Viscose Spun', spec: 'count' },
  { id: 'nylon', label: 'Nylon', spec: 'denier' },
  { id: 'cotton', label: 'Cotton', spec: 'count' },
  { id: 'blend', label: 'Blended', spec: 'count' },
  { id: 'acrylic', label: 'Acrylic', spec: 'count' },
  { id: 'lycra', label: 'Lycra / Spandex', spec: 'denier' },
  { id: 'modal', label: 'Modal', spec: 'count' },
  { id: 'linen', label: 'Linen', spec: 'count' },
  { id: 'other', label: 'Other', spec: 'denier' },
];

export const SHADES = [
  'Raw White',
  'Semi Dull',
  'Bright',
  'Dyed',
  'Melange',
  'Black',
  'Grey',
  'Cationic',
];

export const TWIST_DIRECTIONS = [
  { id: 'S', label: 'S twist' },
  { id: 'Z', label: 'Z twist' },
];

export const PACKINGS = [
  { id: 'bags', label: 'Bags' },
  { id: 'cartons', label: 'Cartons' },
  { id: 'pallets', label: 'Pallets' },
  { id: 'loose', label: 'Loose' },
];

export const RATE_UNITS = [
  { id: 'per_kg', label: 'per kg', basis: 'netWeight' },
  { id: 'per_cone', label: 'per cone', basis: 'cones' },
  { id: 'lumpsum', label: 'lump sum', basis: 'one' },
];

export const PAYMENT_MODES = [
  { id: 'cash', label: 'Cash' },
  { id: 'upi', label: 'UPI' },
  { id: 'neft', label: 'NEFT' },
  { id: 'rtgs', label: 'RTGS' },
  { id: 'imps', label: 'IMPS' },
  { id: 'cheque', label: 'Cheque' },
  { id: 'adjustment', label: 'Adjustment' },
  { id: 'other', label: 'Other' },
];

/** Everything the entry form needs to render, in one response. */
export function reference() {
  return {
    kinds: ENTRY_KINDS,
    accounts: ACCOUNTS,
    yarnTypes: YARN_TYPES,
    shades: SHADES,
    twistDirections: TWIST_DIRECTIONS,
    packings: PACKINGS,
    rateUnits: RATE_UNITS,
    paymentModes: PAYMENT_MODES,
    defaultGstRate: config.defaultGstRate,
  };
}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const ids = (list) => list.map((x) => (typeof x === 'string' ? x : x.id));

const str = (v, max, fallback = '') =>
  v === undefined || v === null ? fallback : String(v).trim().slice(0, max);

const oneOf = (v, list, fallback) => (ids(list).includes(v) ? v : fallback);

/**
 * Weights carry three decimals (grams) and money two (paise). Rounding at the
 * boundary — rather than letting binary floats accumulate through a month of
 * entries — is what keeps a printed statement adding up.
 */
const round = (n, dp) => {
  const f = 10 ** dp;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
};

/**
 * A weight off the wire. Negative is not a weight, so it is refused — a typed
 * "-5" is a mistake, not five kilos owed back.
 */
export const kg = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? round(n, 3) : fallback;
};

/**
 * A weight that has been arithmetic'd — a running balance, a difference, a
 * total. Signed, because these legitimately go negative on the way: an outward
 * entry dated before the inward that supplied it drives the running material
 * balance below zero until the inward is reached, and clamping that to zero
 * silently loses everything subtracted so far.
 *
 * Use `kg` for anything a person typed, and this for anything computed.
 */
export const kgSigned = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? round(n, 3) : fallback;
};

export const money = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? round(n, 2) : fallback;
};

const count = (v, max, fallback = 0) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
};

const pct = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? round(n, 2) : fallback;
};

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/** 22AAAAA0000A1Z5 — state code, PAN, entity digit, 'Z', checksum. */
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export function sanitiseClient(input, existing = {}) {
  const gstin = str(input?.gstin, 15, existing.gstin || '').toUpperCase();

  return {
    name: str(input?.name, 160, existing.name || ''),
    contactPerson: str(input?.contactPerson, 120, existing.contactPerson || ''),
    phone: str(input?.phone, 40, existing.phone || ''),
    email: str(input?.email, 160, existing.email || '').toLowerCase(),
    gstin,
    address: str(input?.address, 400, existing.address || ''),
    city: str(input?.city, 80, existing.city || ''),
    state: str(input?.state, 80, existing.state || ''),

    // Pre-filled into the entry form when this client is picked, so the common
    // case is one tap rather than retyping a rate he agreed months ago.
    defaultRate: money(input?.defaultRate, existing.defaultRate ?? 0),
    defaultRateUnit: oneOf(
      input?.defaultRateUnit,
      RATE_UNITS,
      existing.defaultRateUnit || 'per_kg',
    ),
    defaultGstRate: pct(input?.defaultGstRate, existing.defaultGstRate ?? config.defaultGstRate),

    // What they owed on the day JV started tracking, so balances are right from
    // the first entry instead of only from day one of the app.
    openingBalance: money(input?.openingBalance, existing.openingBalance ?? 0),
    openingBalanceDate: ISO_DATE.test(input?.openingBalanceDate || '')
      ? input.openingBalanceDate
      : existing.openingBalanceDate || '',

    notes: str(input?.notes, 2000, existing.notes || ''),
    active: input?.active === undefined ? existing.active !== false : !!input.active,
  };
}

/** Returns a complaint string, or null when the client is fit to save. */
export function validateClient(client) {
  if (!client.name) return 'A client name is required';
  if (client.gstin && !GSTIN.test(client.gstin)) {
    return 'That GSTIN does not look valid — 15 characters, e.g. 26AAAAA0000A1Z5';
  }
  if (client.email && !client.email.includes('@')) return 'That email address looks invalid';
  return null;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

const MATERIAL_KINDS = ['inward', 'outward'];

/** The quantity a rate is charged on, per the chosen rate unit. */
export function rateBasis(entry) {
  const unit = RATE_UNITS.find((u) => u.id === entry.rateUnit) || RATE_UNITS[0];
  if (unit.basis === 'cones') return entry.cones || 0;
  if (unit.basis === 'one') return 1;
  return entry.netWeight || 0;
}

/**
 * Normalise an entry, preserving fields the client didn't send.
 *
 * Derived values are computed here but remain overridable, because the paper in
 * his hand wins: he often has a net weight straight off a weighbridge slip
 * without a tare, or a rounded-off amount agreed on the phone. So a supplied
 * value is kept, and only a missing one is calculated.
 */
export function sanitiseEntry(input, existing = {}) {
  const kind = oneOf(input?.kind, ENTRY_KINDS, existing.kind || 'inward');
  const isMaterial = MATERIAL_KINDS.includes(kind);

  const base = {
    kind,
    date: ISO_DATE.test(input?.date || '') ? input.date : existing.date || '',
    account: oneOf(input?.account, ACCOUNTS, existing.account || 'jobwork'),
    clientId: str(input?.clientId, 64, existing.clientId || ''),
    // Denormalised so a statement renders without joining the client list, and
    // so history still reads correctly if a client is later renamed.
    clientName: str(input?.clientName, 160, existing.clientName || ''),
    notes: str(input?.notes, 2000, existing.notes || ''),
  };

  if (kind === 'payment') {
    return {
      ...base,
      amount: money(input?.amount, existing.amount ?? 0),
      mode: oneOf(input?.mode, PAYMENT_MODES, existing.mode || 'upi'),
      reference: str(input?.reference, 120, existing.reference || ''),
      // A payment moves money only — zeroed so totals can sum one shape.
      netWeight: 0,
      gstAmount: 0,
      totalAmount: money(input?.amount, existing.amount ?? 0),
    };
  }

  const grossWeight = kg(input?.grossWeight, existing.grossWeight ?? 0);
  const tareWeight = kg(input?.tareWeight, existing.tareWeight ?? 0);
  const suppliedNet = input?.netWeight;
  const netWeight =
    suppliedNet === undefined || suppliedNet === null || suppliedNet === ''
      ? kg(Math.max(0, grossWeight - tareWeight), existing.netWeight ?? 0)
      : kg(suppliedNet, existing.netWeight ?? 0);

  const material = {
    ...base,
    // The lot number is what ties outward back to inward, and so what makes
    // wastage and pending stock computable at all.
    lotNo: str(input?.lotNo, 60, existing.lotNo || ''),
    challanNo: str(input?.challanNo, 60, existing.challanNo || ''),
    partyChallanNo: str(input?.partyChallanNo, 60, existing.partyChallanNo || ''),

    yarnType: oneOf(input?.yarnType, YARN_TYPES, existing.yarnType || 'poly-fdy'),
    denier: str(input?.denier, 40, existing.denier || ''),
    shade: str(input?.shade, 60, existing.shade || ''),
    ply: count(input?.ply, 12, existing.ply ?? 2),
    tpm: count(input?.tpm, 20000, existing.tpm ?? 0),
    twist: oneOf(input?.twist, TWIST_DIRECTIONS, existing.twist || 'S'),

    packing: oneOf(input?.packing, PACKINGS, existing.packing || 'bags'),
    bags: count(input?.bags, 100000, existing.bags ?? 0),
    cones: count(input?.cones, 1000000, existing.cones ?? 0),
    grossWeight,
    tareWeight,
    netWeight,

    vehicleNo: str(input?.vehicleNo, 32, existing.vehicleNo || '').toUpperCase(),
    transporter: str(input?.transporter, 120, existing.transporter || ''),
    lrNo: str(input?.lrNo, 60, existing.lrNo || ''),
  };

  // Inward is material movement only — a client's yarn arriving is not a sale,
  // and nothing is billed until it goes back out.
  if (kind === 'inward') {
    return { ...material, rate: 0, amount: 0, gstRate: 0, gstAmount: 0, totalAmount: 0 };
  }

  const rate = money(input?.rate, existing.rate ?? 0);
  const rateUnit = oneOf(input?.rateUnit, RATE_UNITS, existing.rateUnit || 'per_kg');
  const gstRate = pct(input?.gstRate, existing.gstRate ?? config.defaultGstRate);

  const suppliedAmount = input?.amount;
  const amount =
    suppliedAmount === undefined || suppliedAmount === null || suppliedAmount === ''
      ? money(rate * rateBasis({ ...material, rateUnit }), existing.amount ?? 0)
      : money(suppliedAmount, existing.amount ?? 0);

  const gstAmount = money((amount * gstRate) / 100);

  return {
    ...material,
    rate,
    rateUnit,
    amount,
    gstRate,
    gstAmount,
    totalAmount: money(amount + gstAmount),
  };
}

/** Returns a complaint string, or null when the entry is fit to save. */
export function validateEntry(entry) {
  if (!entry.date) return 'A date is required (YYYY-MM-DD)';
  if (!entry.clientId) return 'Choose a client';
  if (!entry.clientName) return 'Choose a client';

  if (entry.kind === 'payment') {
    if (!(entry.amount > 0)) return 'Enter the amount received';
    return null;
  }

  if (!(entry.netWeight > 0)) {
    return 'Enter a net weight — or a gross and tare weight to derive it';
  }
  if (entry.tareWeight > entry.grossWeight && entry.grossWeight > 0) {
    return 'Tare weight cannot be more than gross weight';
  }
  if (entry.kind === 'outward' && !(entry.totalAmount >= 0)) {
    return 'The billed amount could not be worked out — check the rate';
  }
  return null;
}
