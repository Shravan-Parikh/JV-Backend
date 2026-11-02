#!/usr/bin/env bash
#
# deploy.sh — ship the JV Enterprises API to Cloud Run.
#
# The web app lives in its own repository and deploys with its own script. The
# two services need each other's addresses, so the order on a first deploy is:
#
#   1. this script            → creates jv-api, prints its URL
#   2. the web repo's deploy  → builds against that URL, then points this
#                               service's CORS_ORIGIN at itself
#
# After that, either can be re-run alone. Re-running is how you ship a change.
#
set -euo pipefail

REGION="${JV_REGION:-asia-south1}"        # Mumbai — closest to Silvassa
SERVICE="${JV_API_SERVICE:-jv-api}"

cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die() { printf '\n\033[31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }

# --- Preflight -------------------------------------------------------------

command -v gcloud >/dev/null || die "gcloud is not installed."

gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | grep -q . \
  || die "Not signed in. Run: gcloud auth login"

PROJECT="$(gcloud config get-value project 2>/dev/null)"
[ -n "$PROJECT" ] && [ "$PROJECT" != "(unset)" ] \
  || die "No project set. Run: gcloud config set project <project-id>"

[ -f .env ] || die ".env is missing. Copy .env.example and fill it in."

# The env file is the source of truth for the Firebase values, so a deploy can
# never quietly disagree with what works locally.
read_env() { grep -E "^$1=" .env | cut -d= -f2- || true; }

FIREBASE_API_KEY="$(read_env FIREBASE_API_KEY)"
FIREBASE_PROJECT_ID="$(read_env FIREBASE_PROJECT_ID)"
DEFAULT_GST_RATE="$(read_env DEFAULT_GST_RATE)"
COLLECTION_PREFIX="$(read_env JV_COLLECTION_PREFIX)"
ADMIN_EMAILS="$(read_env ADMIN_EMAILS)"

[ -n "$FIREBASE_API_KEY" ] || die "FIREBASE_API_KEY is empty in .env"
[ -n "$FIREBASE_PROJECT_ID" ] || die "FIREBASE_PROJECT_ID is empty in .env"

say "Deploying $SERVICE to $PROJECT · $REGION"

# Keep whatever CORS origin is already set; the web app's deploy script is what
# puts its own URL here, and a redeploy must not undo that.
EXISTING_CORS="$(gcloud run services describe "$SERVICE" --region "$REGION" \
  --format='value(spec.template.spec.containers[0].env.filter("name:CORS_ORIGIN").extract("value"))' 2>/dev/null || true)"
CORS="${EXISTING_CORS:-${JV_WEB_URL:-http://localhost:3100}}"

# --allow-unauthenticated is correct: the API does its own Firebase token auth
# and the browser calls it directly, so Cloud Run's IAM layer would only get in
# the way.
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --max-instances 3 \
  --memory 512Mi \
  --set-env-vars "FIREBASE_API_KEY=${FIREBASE_API_KEY},FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID},ALLOW_PUBLIC_SIGNUP=false,DEFAULT_GST_RATE=${DEFAULT_GST_RATE:-5},JV_COLLECTION_PREFIX=${COLLECTION_PREFIX:-jv_},ADMIN_EMAILS=${ADMIN_EMAILS},CORS_ORIGIN=${CORS}" \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"

# Cloud Run keeps every image it has ever built, and storage is the only part of
# this that is not free. Keep the newest and drop the rest.
REPO="${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/${SERVICE}"
for digest in $(gcloud artifacts docker images list "$REPO" --include-tags \
  --sort-by=~CREATE_TIME --format='value(version)' 2>/dev/null | tail -n +2 || true); do
  gcloud artifacts docker images delete "${REPO}@${digest}" --delete-tags --quiet >/dev/null 2>&1 || true
done

printf '\n\033[32m✓ API deployed\033[0m\n\n'
printf '  %s/api\n' "$URL"
printf '  Health check:  curl %s/api/health\n\n' "$URL"
printf '  CORS currently admits: %s\n\n' "$CORS"

cat <<NOTE
  Next, in the web repository:

    JV_API_URL=${URL}/api ./scripts/deploy.sh

  It builds the app against that URL and then points this service's CORS at
  itself, so the two ends can talk.

NOTE
