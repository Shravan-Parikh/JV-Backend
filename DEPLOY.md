# Deploying JV Enterprises

Two Cloud Run services, from two repositories, both scaling to zero:

| Service | Repository |
| --- | --- |
| `jv-api` | [JV-Backend](https://github.com/Shravan-Parikh/JV-Backend) — this one |
| `jv-web` | [JV](https://github.com/Shravan-Parikh/JV) |

At this volume both sit inside Cloud Run's permanent free tier (2M requests and
180k vCPU-seconds a month). Scale-to-zero means **no charge when nobody is
using it**, at the cost of roughly two seconds on the first request of the day —
a deliberate trade, since this is one person's side business.

Container images do accrue a few rupees a month in Artifact Registry storage.
`scripts/deploy.sh` keeps only the latest image to hold that down.

## Before the first deploy

**1. Merge the Firestore rules.** Open Firebase Console → Firestore → Rules and
paste the `jv_*` blocks from [`firestore.rules`](firestore.rules) into the
existing ruleset, alongside the blocks already there. Do **not** publish the
file as-is: Firestore rules are project-wide and publishing replaces
everything, which would break the other apps in this project.

> **Done on 2 Nov 2026.** Before that, the project's published rule was
> `match /{document=**} { allow read, write: if true; }` — every collection
> readable *and writable* by anyone on the internet, with no sign-in. An
> unauthenticated GET of `jv_users` returned HTTP 200.
>
> The ruleset now in force locks `jv_*` and `cs_*` to their owners. The other
> apps' collections in that project are named explicitly and keep the
> permissions they already had, so nothing that worked could break — they are
> unchanged, not secured, and still deserve attention app by app.
>
> One behaviour change to know about: with the catch-all gone, a collection that
> is not named in the ruleset is denied by default. If another app starts
> writing to a brand-new collection, add a rule for it first.
>
> To roll back, point the `cloud.firestore` release at the previous ruleset —
> its id is in the deploy notes kept alongside this work, and Firebase Console →
> Firestore → Rules also keeps a version history with one-click revert.

**2. Authenticate and pick the project.**

```bash
gcloud auth login
gcloud config set project <your-project-id>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

## Deploy

The API goes first, because its URL is compiled into the web app's client bundle
at build time. The web app's script then points the API's CORS back at itself,
so the two ends can talk.

```bash
# in JV-Backend
./scripts/deploy.sh

# in JV
./scripts/deploy.sh
```

After the first round, either can be re-run on its own — that is how you ship a
change. The web script finds the API's address from Cloud Run, so it needs no
arguments; pass `JV_API_URL=https://…/api` to override it.

`--allow-unauthenticated` is correct here: the API does its own Firebase token
auth and the browser calls it directly, so Cloud Run's own IAM layer would only
get in the way.

`asia-south1` (Mumbai) is the closest region to Silvassa — roughly 20 ms away
rather than 200.

## Accounts

Sign-ups are closed. Create accounts against the deployed project from your
machine, with `backend/.env` pointing at the same Firebase project:

```bash
cd backend && node scripts/create-user.js "Full Name" person@example.com
```

Re-running it for an existing address repairs that account's profile — which is
how you correct a name — but it then needs the existing password:

```bash
node scripts/create-user.js "Correct Name" person@example.com "<their-password>"
```

Password resets work from the login screen without any of this; Firebase sends
the email itself, at no cost.

## A phone home screen icon

The app is a normal website, so on his phone: open the `jv-web` URL in Safari or
Chrome → Share → **Add to Home Screen**. It then opens full-screen from the home
screen like an app, with the JV monogram as its icon.

## Costs

| | |
| --- | --- |
| Cloud Run | ₹0 — free tier, scales to zero |
| Firestore | ₹0 — a couple of dozen reads per page load against 50,000/day |
| Firebase Auth | ₹0 — email/password is free, including reset emails |
| Artifact Registry | a few rupees a month for the stored images |

## A custom domain

Not needed, but if you want `ledger.jventerprises.in` rather than a `run.app`
URL: Cloud Run → `jv-web` → Manage custom domains, then add the DNS records it
gives you. Remember to add the new origin to the API's `CORS_ORIGIN`, which
accepts a comma-separated list and one `*` label per entry.
