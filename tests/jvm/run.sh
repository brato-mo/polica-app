#!/usr/bin/env bash
# Runs the REAL OpLog.java, MinusApply.java and Sandbox.java on a desktop JVM (Android parts replaced by the small
# stand-ins in stubs/), with the page playing what the real assets/minus-apply.js does in every ending.
#   tests/jvm/run.sh          quick scenarios + restart after the app was killed (about 1 minute)
#   tests/jvm/run.sh long     also the real 2-minute time limits (about 2.5 minutes more)
set -euo pipefail
cd "$(dirname "$0")/../.."
B=build/jvm; mkdir -p $B
[ -d $B/JSON-java ] || git clone -q --depth 1 --branch 20240303 https://github.com/stleary/JSON-java.git $B/JSON-java
python3 - <<'PY'
import re
src = open('src/ba/polica/MainActivity.java').read()
m = re.search(r'    /\*\* Writes through a temporary file.*?\n    static boolean writeAtomic\(File f, byte\[\] data\) \{.*?\n    \}\n', src, re.S)
open('build/jvm/MainActivity.java', 'w').write('package ba.polica;\nimport java.io.*;\n/** writeAtomic, copied unchanged from MainActivity.java. */\nfinal class MainActivity {\n' + m.group(0) + '}\n')
PY
rm -rf $B/out && mkdir -p $B/out
javac -nowarn -d $B/out $(find $B/JSON-java/src/main/java -name '*.java') $(find tests/jvm/stubs -name '*.java') $B/MainActivity.java \
  src/ba/polica/OpLog.java src/ba/polica/MinusApply.java src/ba/polica/Sandbox.java src/ba/polica/Upgrade.java src/ba/polica/StoreTask.java 2>&1 | grep -v "JAVA_TOOL\|^Note" || true
test -f $B/out/ba/polica/Harness.class || { echo "javac failed"; exit 1; }
node tests/jvm/gen.mjs $B/scenarios.json
R="java -cp $B/out -Dscenarios=$B/scenarios.json -Dassets=assets ba.polica.Harness"
$R quick 2>&1 | grep -v JAVA_TOOL
D=$(mktemp -d); $R crash-a "$D" 2>&1 | grep -v JAVA_TOOL || true; $R crash-b "$D" 2>&1 | grep -v JAVA_TOOL
if [ "${1:-}" = long ]; then for m in hang dead login; do $R $m 2>&1 | grep -v JAVA_TOOL & done; wait; fi
