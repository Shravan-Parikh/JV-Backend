# JV Enterprises — API

Inward, outward and payments for **JV Enterprises**, a twisting-yarn
manufacturing unit in Silvassa. The web app lives in a separate repository:
[Shravan-Parikh/JV](https://github.com/Shravan-Parikh/JV).

Twisting is job work: a client sends grey yarn on their delivery challan, JV
adds ply and twist, and returns it on JV's challan with a bill for the
processing charge per kg. JV never owns that material. So two numbers have to be
right at all times, and they are not the same number:

| | |
| --- | --- |
| **Material balance (kg)** | Σ inward net − Σ outward net, per client. Positive means that much of *their* yarn is still on JV's floor. |
| **Money balance (₹)** | opening + Σ outward total − Σ payments, per client. Positive means the client owes JV. |

Yarn always loses a little weight in process, so a finished lot's outward never
equals its inward. That gap is **wastage**, and it is the figure clients argue
about — so it is computed per lot and shown live as an outward entry is typed,
rather than discovered later.

JV also buys and sells on its own account, which is the same paperwork with a
different meaning for the money. Every entry therefore carries an `account` of
`jobwork` or `trading`.

Every derived figure — balances, wastage, running totals — is computed on read
and never stored, so a correction made today fixes last month's balance with no
reconciliation step.

## The stack

Node + Express. Firebase for auth and storage, over its REST APIs rather than
`firebase-admin`, so there is no service-account key to provision, rotate or
leak. Firestore calls carry the signed-in user's ID token, so security rules
genuinely apply; tokens are verified locally against Google's rotating public
certs, so auth costs no network round-trip per request.

```bash
cp .env.example .env
npm install
npm run dev        # http://localhost:4100
npm test           # the money and weight arithmetic
```

Then create an account — sign-ups are closed by design:

```bash
node scripts/create-user.js "Full Name" person@example.com
```

It prints a generated password. Emails listed in `ADMIN_EMAILS` become admins.
Password resets work from the login screen; Firebase sends the email itself, at
no cost.

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `FIREBASE_API_KEY` | ✅ | Firebase **web** API key. Public by design — access is governed by Firestore rules, not this key. |
| `FIREBASE_PROJECT_ID` | ✅ | Firebase project id. |
| `PORT` | — | Defaults to 4100. Cloud Run injects 8080. |
| `CORS_ORIGIN` | — | Comma-separated origins. Supports one `*` label, e.g. `https://*.run.app`. |
| `ALLOW_PUBLIC_SIGNUP` | — | `false`. Accounts are provisioned. |
| `ADMIN_EMAILS` | — | Comma-separated emails that get the `admin` role. |
| `DEFAULT_GST_RATE` | — | Defaults to 5. Overridable per client and per entry. |
| `JV_COLLECTION_PREFIX` | — | Defaults to `jv_`. Set empty once JV has its own Firebase project. |

The server **refuses to boot** without the two Firebase values, so a
misconfigured deploy fails loudly instead of silently serving broken auth.

## Layout

```
src/
├── collections.js   every Firestore path, in one place — the later project split
├── firebase.js      Firebase REST: Identity Toolkit + Firestore. The one module
│                    that knows Firebase exists
├── yarn.js          the trade's vocabulary + sanitising and arithmetic on an entry
├── ledger.js        what the entries add up to — balances, lots, wastage
├── ledgerStore.js   reading and writing the month-partitioned ledger
└── routes/          auth · clients · entries · ledger · export
```

Validation and all money/weight arithmetic live in `yarn.js` and `ledger.js`,
never in a route and never in the browser — so a create, an edit and anything
imported later all obey one set of rules.

## API

```
POST   /api/auth/login · refresh · forgot-password     GET /api/auth/me
POST   /api/auth/admin/users       (admin)             GET /api/auth/admin/users

GET    /api/reference              yarn types, shades, twist, modes, units

GET    /api/clients                POST   /api/clients
PATCH  /api/clients/:id            DELETE /api/clients/:id

GET    /api/entries?from&to&client&kind&account&lot&q
POST   /api/entries
PATCH  /api/entries/:id            DELETE /api/entries/:id?date=

GET    /api/ledger/summary         balances per client, totals, open lots
GET    /api/ledger/statement?client=&from=&to=
GET    /api/export/ledger.csv      same filters as /entries
```

`DELETE /api/clients/:id` only deletes a client with no entries; one that has
been traded with is **deactivated** instead, so its history keeps a name and its
balance keeps counting. The response says which happened.

`PATCH`/`DELETE` on an entry accept the entry's current date, which tells the
server which month document to open rather than scanning the book for one row.

## Tests

```bash
npm test                                  # the money and weight arithmetic
node test/e2e.mjs <email> <password>      # drives a running API end to end
```

`test/domain.mjs` pins the figures that must never be wrong, using a worked
example you can check on a calculator: 100 kg in on lot L-001, 98.5 kg back out
at ₹18/kg plus 5% GST, ₹1,000 paid on account → 1.5 kg and 1.50% wastage left on
the lot, and ₹861.65 outstanding.

`test/e2e.mjs` writes real entries, so point it at a throwaway account. It
exists mainly to cover the month partitioning, which the pure domain tests
cannot see — an entry whose date is edited across a month boundary has to move
between two documents without being duplicated or lost.

## Scripts

```bash
./scripts/deploy.sh                                             # ship to Cloud Run
node scripts/create-user.js "Full Name" person@example.com      # provision an account
node scripts/migrate-firebase.js export  <email> <password>     # backup / move out
node scripts/migrate-firebase.js import  <email> <password> f.json
```

## Firebase

JV shares a Firebase project with another app for now, so every collection is
prefixed `jv_` and all of them are named in exactly one file,
`src/collections.js`. Moving to a dedicated project later means two env vars and
one script:

```bash
# dump from the current project
node scripts/migrate-firebase.js export jv@example.com 'password' > jv-backup.json

# load into the new one
FIREBASE_API_KEY=<new> FIREBASE_PROJECT_ID=<new> \
  node scripts/migrate-firebase.js import jv@example.com 'password' jv-backup.json
```

Both halves run **as the user**, so the same security rules apply and no
service-account key is needed at either end. The export is a perfectly good
backup on its own — worth running periodically regardless of any move.

> **Security rules** live in [`firestore.rules`](firestore.rules) and are a
> *fragment to merge*, not a ruleset to publish. Firestore rules are
> project-wide and publishing replaces everything, so pasting that file in as-is
> would drop the other apps' rules. See the warning at the top of it.

## Deploy

See [DEPLOY.md](DEPLOY.md). Both halves run on Cloud Run, scale to zero, and sit
inside the free tier at this volume.

## Why the ledger is partitioned by month

A handful of entries a day would pass Firestore's 1 MB document limit inside a
year, so entries live one document per month under `jv_ledgers/{uid}/months/`,
with a summary document naming the months that exist.

That makes **every read a direct `get` by an id already in hand** — nothing is
ever queried. No composite indexes to deploy, no index errors on first use, and
no query that could stray into the collections of the other app sharing this
Firebase project.

Writes are read-modify-write on a single month document. This is a
single-operator tool, so there is no concurrent writer to lose an update to; if
JV ever puts two people on the ledger at once, `ledgerStore.js` is the file that
needs a transaction.
