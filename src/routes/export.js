/**
 * export.js — CSV out, for the accountant.
 *
 * Deliberately one flat row per entry with every field spelled out, rather than
 * a tidy summary: the person opening this in Excel wants to pivot it themselves,
 * and a derived figure they can't trace back is worse than a wide sheet.
 *
 * The token can't ride on a download the browser opens in a new tab, so the
 * frontend fetches this with its Authorization header and saves the blob.
 */

import { Router } from 'express';
import { FirebaseError } from '../firebase.js';
import { requireAuth } from '../middleware/auth.js';
import { logEvent } from '../activity.js';
import { readEntries } from '../ledgerStore.js';
import { withRunningBalance } from '../ledger.js';
import { YARN_TYPES, PAYMENT_MODES, RATE_UNITS } from '../yarn.js';
import { applyFilters, range } from './entries.js';

const router = Router();

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    const status = e instanceof FirebaseError ? e.status : 500;
    res.status(status).json({ error: e.message || 'Something went wrong' });
  }
};

const label = (list, id) => list.find((x) => x.id === id)?.label || id || '';

/**
 * Excel reads a bare `=` or `+` as a formula, so any cell starting with one is
 * prefixed. A lot number like `-01` is otherwise silently mangled.
 */
function cell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const COLUMNS = [
  ['Date', (e) => e.date],
  ['Type', (e) => e.kind.charAt(0).toUpperCase() + e.kind.slice(1)],
  ['Account', (e) => (e.account === 'trading' ? 'Own trading' : 'Job work')],
  ['Client', (e) => e.clientName],
  ['Lot No', (e) => e.lotNo],
  ['Our Challan', (e) => e.challanNo],
  ['Party Challan', (e) => e.partyChallanNo],
  ['Yarn', (e) => label(YARN_TYPES, e.yarnType)],
  ['Denier / Count', (e) => e.denier],
  ['Shade', (e) => e.shade],
  ['Ply', (e) => e.ply || ''],
  ['TPM', (e) => e.tpm || ''],
  ['Twist', (e) => e.twist],
  ['Packing', (e) => e.packing],
  ['Bags', (e) => e.bags || ''],
  ['Cones', (e) => e.cones || ''],
  ['Gross Wt (kg)', (e) => (e.grossWeight ? e.grossWeight.toFixed(3) : '')],
  ['Tare Wt (kg)', (e) => (e.tareWeight ? e.tareWeight.toFixed(3) : '')],
  ['Inward Wt (kg)', (e) => (e.kind === 'inward' ? (e.netWeight || 0).toFixed(3) : '')],
  ['Outward Wt (kg)', (e) => (e.kind === 'outward' ? (e.netWeight || 0).toFixed(3) : '')],
  ['Rate', (e) => (e.rate ? e.rate.toFixed(2) : '')],
  ['Rate Unit', (e) => (e.rate ? label(RATE_UNITS, e.rateUnit) : '')],
  ['Taxable Amount', (e) => (e.kind === 'outward' ? (e.amount || 0).toFixed(2) : '')],
  ['GST %', (e) => (e.kind === 'outward' ? (e.gstRate ?? '') : '')],
  ['GST Amount', (e) => (e.kind === 'outward' ? (e.gstAmount || 0).toFixed(2) : '')],
  ['Invoice Total', (e) => (e.kind === 'outward' ? (e.totalAmount || 0).toFixed(2) : '')],
  ['Payment Received', (e) => (e.kind === 'payment' ? (e.amount || 0).toFixed(2) : '')],
  ['Payment Mode', (e) => (e.kind === 'payment' ? label(PAYMENT_MODES, e.mode) : '')],
  ['Payment Ref', (e) => (e.kind === 'payment' ? e.reference : '')],
  ['Vehicle', (e) => e.vehicleNo],
  ['Transporter', (e) => e.transporter],
  ['LR No', (e) => e.lrNo],
  ['Notes', (e) => e.notes],
  ['Running Balance', (e) => (e.runningBalance === undefined ? '' : e.runningBalance.toFixed(2))],
];

router.get(
  '/export/ledger.csv',
  requireAuth,
  handle(async (req, res) => {
    const { from, to } = range(req);
    const all = await readEntries(req, { from, to });
    let entries = applyFilters(all, req.query);

    // A running balance is only meaningful down one client's column; across
    // clients it would be a number nobody could act on, so it is left blank.
    if (req.query.client) entries = withRunningBalance(entries);

    const rows = [
      COLUMNS.map(([head]) => cell(head)).join(','),
      ...entries.map((e) => COLUMNS.map(([, get]) => cell(get(e))).join(',')),
    ];

    const stamp = new Date().toISOString().slice(0, 10);
    const name = `jv-ledger-${stamp}.csv`;

    logEvent(req, 'export.csv', { rows: entries.length });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    // Excel on Windows assumes the system codepage without a BOM, which turns
    // the rupee sign and any Gujarati in a client's name into noise.
    res.send('﻿' + rows.join('\r\n') + '\r\n');
  }),
);

export default router;
