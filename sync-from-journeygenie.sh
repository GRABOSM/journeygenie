#!/usr/bin/env bash
# Re-copy deployable app files from ../journeygenie into this folder (GitHub-only tree).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/journeygenie"
DST="$ROOT/journeygenie-public"
if [[ ! -d "$SRC/src" ]]; then
  echo "Expected sibling repo at: $SRC" >&2
  exit 1
fi
rsync -a --delete "$SRC/src/" "$DST/src/"
rsync -a --delete "$SRC/public/" "$DST/public/"
rsync -a --delete "$SRC/workers/" "$DST/workers/"
rsync -a --delete "$SRC/.github/" "$DST/.github/"
for f in package.json package-lock.json .gitignore .env.example README.md LICENSE; do
  [[ -f "$SRC/$f" ]] && cp "$SRC/$f" "$DST/$f"
done
rm -f "$DST/.env" "$DST/.env.local" "$DST/.env.production" 2>/dev/null || true
echo "Synced $SRC -> $DST (src, public, workers, .github, root manifests). Commit and push from $DST."
