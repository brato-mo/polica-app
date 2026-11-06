#!/usr/bin/env bash
# Removes personal data from the WHOLE git history of the repository, with as little effect as possible on the phones,
# the development branches and the automatic update. Nothing irreversible happens without --execute.
#
#   maint/clean-history.sh             dry run: backup, rewrite in a scratch copy, checks, a report. GitHub untouched.
#   maint/clean-history.sh --execute   the same, then force-push of the rewritten history (only after the owner's
#                                      final approval, and only when every phone runs 1.58 or newer)
#
# What is removed: dist/Polica.apk from every commit (old APKs carried a name and number), and every word listed in
# keystore/private-words.txt (private, never published) in every file and every commit message, upper or lower case.
# What stays: every branch and commit (with new ids), every other file as it was, dist/version.json (the phones read it).
# GitHub keeps refs/pull/* read-only: those three are cleaned by GitHub Support afterwards (see the report).
set -euo pipefail
cd "$(dirname "$0")/.."
EXECUTE=0; [ "${1:-}" = --execute ] && EXECUTE=1
REPO="$(tr -d ' \r\n' < update-repo.txt)"
WORDS=keystore/private-words.txt
FR="${FILTER_REPO:-git-filter-repo}"   # git-filter-repo 2.47 or newer (for --sensitive-data-removal)
OUT="${OUT:-$HOME/polica-history-$(date +%Y%m%d-%H%M)}"
[ -s "$WORDS" ] || { echo "missing $WORDS"; exit 1; }
"$FR" --version >/dev/null 2>&1 || python3 "$FR" --version >/dev/null 2>&1 || { echo "git-filter-repo not found (FILTER_REPO=...)"; exit 1; }
run_fr() { if command -v "$FR" >/dev/null 2>&1; then "$FR" "$@"; else python3 "$FR" "$@"; fi; }
mkdir -p "$OUT"

echo "1. backup (kept, nothing is ever deleted): $OUT"
git bundle create "$OUT/local-all.bundle" --all >/dev/null 2>&1
git bundle verify "$OUT/local-all.bundle" >/dev/null 2>&1 && echo "   local bundle ok"
git clone -q --mirror "https://github.com/$REPO" "$OUT/github-before.git"
echo "   GitHub mirror: $(git -C "$OUT/github-before.git" for-each-ref | wc -l) refs"

echo "2. rewrite in a copy"
cp -r "$OUT/github-before.git" "$OUT/work.git"
python3 - "$WORDS" "$OUT/rules.txt" <<'PY'
import re, sys
toks = [t for t in re.split(r'[,;\s]+', open(sys.argv[1], encoding='utf-8').read()) if len(t) >= 4]
with open(sys.argv[2], 'w', encoding='utf-8') as f:
    for i, t in enumerate(toks): f.write(f"regex:(?i){re.escape(t)}==>REDACTED{i}\n")
PY
( cd "$OUT/work.git" && run_fr --force --sensitive-data-removal --invert-paths --path dist/Polica.apk \
    --replace-text ../rules.txt --replace-message ../rules.txt > ../filter-repo.log 2>&1 ) || { cat "$OUT/filter-repo.log"; exit 1; }
git -C "$OUT/work.git" gc -q --prune=now

echo "3. checks"
python3 - "$WORDS" "$OUT/work.git" <<'PY'
import re, subprocess, sys
toks = [t for t in re.split(r'[,;\s]+', open(sys.argv[1], encoding='utf-8').read()) if len(t) >= 4]
d = subprocess.run(['git', '-C', sys.argv[2], 'cat-file', '--batch-all-objects', '--batch'], capture_output=True).stdout.lower()
n = sum(d.count(t.lower().encode()) for t in toks)
print('   private words left in any object:', n)
sys.exit(1 if n else 0)
PY
for b in $(git -C "$OUT/github-before.git" for-each-ref --format='%(refname:short)' refs/heads); do
  old=$(git -C "$OUT/github-before.git" ls-tree -r "$b" | grep -v $'\tdist/Polica.apk$' | awk '{print $3, $4}' | sort | md5sum)
  new=$(git -C "$OUT/work.git" ls-tree -r "$b" | awk '{print $3, $4}' | sort | md5sum)
  c1=$(git -C "$OUT/github-before.git" rev-list --count "$b"); c2=$(git -C "$OUT/work.git" rev-list --count "$b")
  [ "$old" = "$new" ] && same="files the same apart from the APK" || same="FILES DIFFER (words replaced)"
  echo "   branch $b: $c1 -> $c2 commits, $same"
done
git -C "$OUT/work.git" show main:dist/version.json >/dev/null && echo "   dist/version.json still on main (phones keep finding updates)"
FIRST=$(grep -A50 -i "first changed commit" "$OUT/filter-repo.log" | head -20 || true)
echo "4. for GitHub Support (refs/pull/1-3 are read-only for everyone but GitHub)"
echo "   repository: $REPO, affected pull requests: $(git -C "$OUT/github-before.git" for-each-ref refs/pull | grep -c /head)"
echo "   first changed commit(s), from git-filter-repo:"; echo "$FIRST" | sed 's/^/     /'

if [ "$EXECUTE" = 1 ]; then
  echo "5. force-push of the rewritten history (refs/pull/* will be refused: expected)"
  ( cd "$OUT/work.git" && git push --force --mirror "https://github.com/$REPO" ) || true
  echo "   done. Next: GitHub Support with the lines of step 4; then clone the repository again everywhere."
else
  echo "5. dry run: GitHub untouched. Run with --execute only after the final approval."
fi
