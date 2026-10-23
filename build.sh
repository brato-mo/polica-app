#!/usr/bin/env bash
# Builds a signed APK without Gradle:
#   aapt2 (manifest + resources + assets) -> javac (app + ZXing decoder) -> dx -> zip -> uber-apk-signer
set -euo pipefail
cd "$(dirname "$0")"

T=/home/claude/tools/bin
AJAR="$T/android.jar"
VERSION_CODE="${VERSION_CODE:-1}"
VERSION_NAME="${VERSION_NAME:-1.0}"
KS_PASS="$(cat keystore/password.txt)"

rm -rf build && mkdir -p build/gen build/classes build/dex out

echo "1/5 resources"
# two values that are not part of the source: the address of the store system's web front (private file in
# keystore/, never published) and the place the app looks for updates (update-repo.txt)
HOSTNAME="$(tr -d ' \r\n' < keystore/host.txt | rev)"
UPDATE_REPO="$(tr -d ' \r\n' < update-repo.txt)"
# the name the app shows (launcher, title, texts): private file keystore/appname.txt; without it the neutral name
APPNAME="Polica"
if [ -s keystore/appname.txt ]; then APPNAME="$(tr -d '\r\n' < keystore/appname.txt)"; fi
case "$APPNAME" in *[\<\>\&\'\"\`\$\\]*) echo "app name must not contain < > & ' \" \` $ \\"; exit 1;; esac
mkdir -p build/res-gen/values
cat > build/res-gen/values/config.xml <<XML
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="storefront_host" translatable="false">$HOSTNAME</string>
    <string name="update_repo" translatable="false">$UPDATE_REPO</string>
    <string name="app_name">$APPNAME</string>
    <string name="import_label">Dodaj u $APPNAME</string>
</resources>
XML
# the pages carry the token @APP@ where the name goes; the copy that is packed has the real name
cp -r assets build/assets-gen
python3 - "$APPNAME" <<'PY'
import os, sys
name = sys.argv[1]
for root, _, files in os.walk('build/assets-gen'):
    if 'vendor' in root.split(os.sep):
        continue
    for f in files:
        if f.endswith(('.html', '.js', '.css')):
            p = os.path.join(root, f)
            s = open(p, encoding='utf-8').read()
            if '@APP@' in s:
                open(p, 'w', encoding='utf-8').write(s.replace('@APP@', name))
PY
"$T/aapt2" compile --dir res -o build/res.zip
"$T/aapt2" compile --dir build/res-gen -o build/res-gen.zip
"$T/aapt2" link -o build/app-unsigned.apk -I "$AJAR" --manifest AndroidManifest.xml -A build/assets-gen \
  --min-sdk-version 26 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -0 woff -0 wasm -0 pdf \
  --java build/gen build/res.zip build/res-gen.zip

echo "2/5 java"
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 -bootclasspath "$AJAR" \
  -d build/classes $(find src build/gen third_party/zxing -name '*.java') 2>&1 | grep -v JAVA_TOOL_OPTIONS || true
test -f build/classes/ba/polica/MainActivity.class
test -f build/classes/ba/polica/ScanActivity.class

echo "3/5 dex"
java -cp "$T/dx-30.0.2.jar" com.android.dx.command.Main --dex --min-sdk-version=26 \
  --output=build/dex/classes.dex build/classes 2>&1 | grep -v JAVA_TOOL_OPTIONS || true
test -f build/dex/classes.dex

echo "4/5 package"
(cd build/dex && zip -q -X ../app-unsigned.apk classes.dex)

echo "5/5 align + sign"
java -jar "$T/uber-apk-signer.jar" -a build/app-unsigned.apk -o build/signed \
  --ks keystore/release.jks --ksAlias polica --ksPass "$KS_PASS" --ksKeyPass "$KS_PASS" 2>&1 \
  | grep -v JAVA_TOOL_OPTIONS | grep -E -i "error|fail|signed|verify" | head -20 || true
cp build/signed/*-aligned-signed.apk "out/Polica-$VERSION_NAME.apk"
ls -la out
