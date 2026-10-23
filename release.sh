#!/usr/bin/env bash
# Builds the next version, publishes it in dist/ and pushes. The app reads dist/version.json to update itself.
#   ./release.sh 1.13 "Short note on what changed"
set -euo pipefail
cd "$(dirname "$0")"
NAME="${1:?version name, e.g. 1.13}"
NOTES="${2:-}"
CODE=$(( $(cat version-code.txt) + 1 ))

VERSION_CODE="$CODE" VERSION_NAME="$NAME" ./build.sh
mkdir -p dist
cp "out/Polica-$NAME.apk" dist/Polica.apk
python3 - "$CODE" "$NAME" "$NOTES" <<'PY'
import hashlib, json, os, sys
code, name, notes = int(sys.argv[1]), sys.argv[2], sys.argv[3]
data = open('dist/Polica.apk', 'rb').read()
json.dump({'code': code, 'name': name, 'notes': notes, 'size': len(data),
           'sha256': hashlib.sha256(data).hexdigest()}, open('dist/version.json', 'w'), ensure_ascii=False, indent=1)
PY
echo "$CODE" > version-code.txt
git add -A
# TRAILERS (optional, set by whoever runs the script) is added to the end of the commit message
git -c user.name="Polica" -c user.email="polica@users.noreply.github.com" commit -q -m "Version $NAME${NOTES:+: $NOTES}" ${TRAILERS:+-m "$TRAILERS"}
git push -q origin HEAD:main
echo "published $NAME (code $CODE)"
