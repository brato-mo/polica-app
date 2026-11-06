#!/usr/bin/env bash
# Builds a signed APK without Gradle:
#   aapt2 (manifest + resources + assets) -> javac (app + ZXing decoder) -> dx -> zip -> uber-apk-signer
set -euo pipefail
cd "$(dirname "$0")"

T=/home/claude/tools/bin
AJAR="$T/android.jar"
VERSION_CODE="${VERSION_CODE:-1}"
VERSION_NAME="${VERSION_NAME:-1.0}"
# TEST=1: a test build that installs NEXT TO the real app (package ba.polica.test, name "... TEST", its own data,
# signed with keystore/test.jks, made here if missing), so trying it never touches the real app or its data
TEST="${TEST:-0}"
# RC=1: a release candidate with the real package and signing key (installs over the real app, keeps its data) that,
# like a test build, never writes to StoreFront or MYJYSK (Sandbox). TEST=1 is always like that too.
RC="${RC:-0}"
SANDBOX=""
if [ "$TEST" = 1 ] || [ "$RC" = 1 ]; then SANDBOX=1; fi
if [ "$TEST" = 1 ]; then
  if [ ! -f keystore/test.jks ]; then
    mkdir -p keystore && keytool -genkeypair -keystore keystore/test.jks -alias polica -storepass testtest -keypass testtest \
      -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Test" >/dev/null 2>&1
  fi
  KS=keystore/test.jks; KS_PASS=testtest
else
  KS=keystore/release.jks; KS_PASS="$(cat keystore/password.txt)"
fi

rm -rf build && mkdir -p build/gen build/classes build/dex out

echo "1/5 resources"
# two values that are not part of the source: the address of the store system's web front (private file in
# keystore/, never published) and the place the app looks for updates (update-repo.txt)
HOSTNAME="$(tr -d ' \r\n' < keystore/host.txt | rev)"
UPDATE_REPO="$(tr -d ' \r\n' < update-repo.txt)"
# a test build never updates itself from the real app's releases
if [ "$TEST" = 1 ]; then UPDATE_REPO=""; fi
# MYJYSK (tasks and news): its address, a private file in keystore/; without it the app simply has no MYJYSK.
# Who the employee is (name, number) is never built in: the app asks StoreFront once and keeps it on the phone
# (Postavke), so no APK, test or public file carries a person's data.
MJHOST=""
if [ -s keystore/myjysk-host.txt ]; then MJHOST="$(tr -d ' \r\n' < keystore/myjysk-host.txt | rev)"; fi
# the planogram server the store concept pages link to (private file); planograms are downloaded only from there
PLHOST=""
if [ -s keystore/plans-host.txt ]; then PLHOST="$(tr -d ' \r\n' < keystore/plans-host.txt | rev)"; fi
case "$MJHOST$PLHOST" in *[\<\>\&\'\"\`\$\\]*) echo "MYJYSK files must not contain < > & ' \" \` $ \\"; exit 1;; esac
# the name the app shows (launcher, title, texts): private file keystore/appname.txt; without it the neutral name
APPNAME="Polica"
if [ -s keystore/appname.txt ]; then APPNAME="$(tr -d '\r\n' < keystore/appname.txt)"; fi
if [ "$TEST" = 1 ]; then APPNAME="$APPNAME TEST"; fi
case "$APPNAME" in *[\<\>\&\'\"\`\$\\]*) echo "app name must not contain < > & ' \" \` $ \\"; exit 1;; esac
mkdir -p build/res-gen/values
cat > build/res-gen/values/config.xml <<XML
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="storefront_host" translatable="false">$HOSTNAME</string>
    <string name="update_repo" translatable="false">$UPDATE_REPO</string>
    <string name="myjysk_host" translatable="false">$MJHOST</string>
    <string name="plans_host" translatable="false">$PLHOST</string>
    <string name="sandbox" translatable="false">$SANDBOX</string>
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
  -0 woff -0 wasm -0 pdf $( [ "$TEST" = 1 ] && echo "--rename-manifest-package ba.polica.test" ) \
  --java build/gen build/res.zip build/res-gen.zip

echo "2/5 java"
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 -bootclasspath "$AJAR" \
  -d build/classes $(find src build/gen third_party/zxing -name '*.java') 2>&1 | grep -v JAVA_TOOL_OPTIONS || true
test -f build/classes/ba/polica/MainActivity.class
test -f build/classes/ba/polica/ScanActivity.class

echo "3/5 dex"
if [ -f "$T/dx-30.0.2.jar" ]; then
  java -cp "$T/dx-30.0.2.jar" com.android.dx.command.Main --dex --min-sdk-version=26 \
    --output=build/dex/classes.dex build/classes 2>&1 | grep -v JAVA_TOOL_OPTIONS || true
else
  java -cp "$T/d8.jar" com.android.tools.r8.D8 --min-api 26 --lib "$AJAR" --output build/dex \
    $(find build/classes -name '*.class') 2>&1 | grep -v JAVA_TOOL_OPTIONS || true
fi
test -f build/dex/classes.dex

echo "4/5 package"
(cd build/dex && zip -q -X ../app-unsigned.apk classes.dex)

echo "5/5 align + sign"
java -jar "$T/uber-apk-signer.jar" -a build/app-unsigned.apk -o build/signed \
  --ks "$KS" --ksAlias polica --ksPass "$KS_PASS" --ksKeyPass "$KS_PASS" 2>&1 \
  | grep -v JAVA_TOOL_OPTIONS | grep -E -i "error|fail|signed|verify" | head -20 || true
cp build/signed/*-aligned-signed.apk "out/Polica-$VERSION_NAME.apk"
ls -la out

# Guard: no person's data in what is built. keystore/private-words.txt (private, never published) lists words that
# must never be in an APK (a name, an employee number); the build fails if any of them is found in the file or in
# any file packed inside it.
if [ -s keystore/private-words.txt ]; then
  python3 - "out/Polica-$VERSION_NAME.apk" keystore/private-words.txt <<'PY'
import re, sys, zipfile
apk, words = sys.argv[1], sys.argv[2]
toks = [t for t in re.split(r'[,;\s]+', open(words, encoding='utf-8').read()) if len(t) >= 4]
blobs = [open(apk, 'rb').read()]
with zipfile.ZipFile(apk) as z:
    blobs += [z.read(n) for n in z.namelist()]
for b in blobs:
    for enc in ('utf-8', 'utf-16-le'):
        for t in toks:
            if t.encode(enc) in b or t.lower().encode(enc) in b.lower():
                sys.exit('STOP: a private word is inside the APK (not printed). Nothing was published.')
print('private data check: clean')
PY
fi
