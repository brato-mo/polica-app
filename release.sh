#!/usr/bin/env bash
# Builds the next version, publishes it and pushes. The app reads dist/version.json to update itself.
#   ./release.sh 1.13 "Short note on what changed"
# Where the APK goes (DIST):
#   DIST=repo     (default) the APK is committed as dist/Polica.apk, as up to 1.57. Every installed version can
#                 update from it.
#   DIST=release  the APK goes to a GitHub release of the repository (tag v<version>) and only dist/version.json,
#                 with the release file's address in "url", is committed. Only versions from 1.58 on understand "url",
#                 so this is used only after the phones have 1.58 or newer.
# Nothing is published from a branch other than main.
set -euo pipefail
cd "$(dirname "$0")"
NAME="${1:?version name, e.g. 1.13}"
NOTES="${2:-}"
DIST="${DIST:-repo}"
CODE=$(( $(cat version-code.txt) + 1 ))
REPO="$(tr -d ' \r\n' < update-repo.txt)"

[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "release only from main"; exit 1; }

VERSION_CODE="$CODE" VERSION_NAME="$NAME" ./build.sh # stops if a private word is found in the APK
APK="out/Polica-$NAME.apk"
mkdir -p dist

URL=""
if [ "$DIST" = release ]; then
  TAG="v$NAME"
  # the release, then its one file (the same API GitHub's own pages use)
  RID=$(gh api -X POST "repos/$REPO/releases" -f tag_name="$TAG" -f target_commitish=main -f name="$NAME" -f body="$NOTES" --jq .id)
  gh api -X POST "https://uploads.github.com/repos/$REPO/releases/$RID/assets?name=Polica.apk" \
    -H "Content-Type: application/vnd.android.package-archive" --input "$APK" --jq .browser_download_url >/dev/null
  URL="https://github.com/$REPO/releases/download/$TAG/Polica.apk"
  git rm -q --cached --ignore-unmatch dist/Polica.apk
  rm -f dist/Polica.apk
else
  cp "$APK" dist/Polica.apk
fi

python3 - "$CODE" "$NAME" "$NOTES" "$APK" "$URL" <<'PY'
import hashlib, json, sys
code, name, notes, apk, url = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
data = open(apk, 'rb').read()
v = {'code': code, 'name': name, 'notes': notes, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
if url:
    v['url'] = url
json.dump(v, open('dist/version.json', 'w'), ensure_ascii=False, indent=1)
PY
echo "$CODE" > version-code.txt
git add -A
if [ "$DIST" = repo ]; then git add -f dist/Polica.apk; fi
git add -f dist/version.json
# TRAILERS (optional, set by whoever runs the script) is added to the end of the commit message
git -c user.name="Polica" -c user.email="polica@users.noreply.github.com" commit -q -m "Version $NAME${NOTES:+: $NOTES}" ${TRAILERS:+-m "$TRAILERS"}
git push -q origin HEAD:main
echo "published $NAME (code $CODE, $DIST)"
