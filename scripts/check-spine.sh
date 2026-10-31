#!/bin/sh
# Check the cross-references between the spine docs, the plans and the skills:
# every INV-n and Dn cited exists, invariant numbers are unique, and every test
# or script an invariant plans appears in the plan of the milestone it names.
# Exits non-zero on any problem. Meant for CI, pre-commit and plan reviews.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
inv="$root/docs/invariants.md"
design="$root/docs/design.md"
plans="$root/docs/plans"
fail=0
err() { echo "$1: $2" >&2; fail=1; }

# Files that may cite invariant or decision IDs.
set -- "$root/AGENTS.md" "$root/plan.md" "$root"/docs/*.md "$plans"/*.md "$root"/.agents/skills/*/SKILL.md "$root"/.agents/skills/*/*.md

# Invariant numbers are defined once.
defined_inv=$(sed -n 's/^- \*\*INV-\([0-9]*\)[: (].*/\1/p' "$inv" | sort -n)
for n in $(printf '%s\n' "$defined_inv" | uniq -d); do
  err "docs/invariants.md" "INV-$n is defined more than once"
done

# Decision IDs are the "### Dn - ..." headings in design.md.
defined_d=$(sed -n 's/^### D\([0-9]*\) .*/\1/p' "$design" | sort -n)

# Every INV-n and Dn cited anywhere exists.
for f in "$@"; do
  [ -f "$f" ] || continue
  rel=${f#"$root"/}
  grep -no 'INV-[0-9][0-9]*' "$f" | sort -u | while IFS=: read -r line id; do
    printf '%s\n' "$defined_inv" | grep -qx "${id#INV-}" || echo "$rel:$line: cites $id, which docs/invariants.md does not define"
  done
  grep -noE '(^|[^A-Za-z0-9_-])D[0-9]{1,2}([^0-9A-Za-z_]|$)' "$f" | sed -E 's/^([0-9]+):.*D([0-9]+).*/\1 \2/' | sort -u | while read -r line n; do
    printf '%s\n' "$defined_d" | grep -qx "$n" || echo "$rel:$line: cites D$n, which docs/design.md does not define"
  done
done > "${TMPDIR:-/tmp}/check-spine.$$" 2>&1
if [ -s "${TMPDIR:-/tmp}/check-spine.$$" ]; then cat "${TMPDIR:-/tmp}/check-spine.$$" >&2; fail=1; fi
rm -f "${TMPDIR:-/tmp}/check-spine.$$"

# The plan file for a milestone ID (M0 and M11 live in the overview).
plan_for() {
  case "$1" in
    M0|M11) echo "$plans/00-overview.md" ;;
    M[1-9]) ls "$plans"/0"${1#M}"-*.md 2>/dev/null ;;
    M10) ls "$plans"/10-*.md 2>/dev/null ;;
    M1[2-9]) ls "$plans"/"${1#M}"-*.md 2>/dev/null ;;
  esac
}

# Every .ts file an invariant plans is named in the plan of a milestone it lists.
# The planned clause is "(planned: <paths> — M1, M8; <paths> — M6)".
sed -n 's/^- \*\*\(INV-[0-9]*\)[: (].*\*(planned: \(.*\))\*.*/\1|\2/p' "$inv" | while IFS='|' read -r id clause; do
  printf '%s\n' "$clause" | tr ';' '\n' | while read -r seg; do
    ms=$(printf '%s\n' "$seg" | sed -n 's/.* — \(.*\)$/\1/p' | grep -oE 'M[0-9]+' || true)
    [ -n "$ms" ] || continue
    for path in $(printf '%s\n' "$seg" | grep -oE '`[^`]+\.ts`' | tr -d '`'); do
      base=$(basename "$path")
      # Match the name itself, its stem inside a brace list (`test/unit/{a,b}.test.ts`),
      # or the stem as a test ID in backticks (`no-repo-write`), as the plans' Tests sections name them.
      stem=${base%%.*}
      ext=${base#"$stem"}
      re_stem=$(printf '%s' "$stem" | sed 's/[*]/[^ `,{}]*/g')
      re_ext=$(printf '%s' "$ext" | sed 's/[.]/[.]/g')
      pattern="(^|[^A-Za-z0-9_-])$re_stem$re_ext|[{,]$re_stem[,}][^ \`]*$re_ext|\`$re_stem\`"
      found=no
      for m in $ms; do
        file=$(plan_for "$m")
        [ -n "$file" ] && grep -qE "$pattern" "$file" && found=yes && break
      done
      [ "$found" = yes ] || echo "docs/invariants.md: $id plans $path, but the plan for $(echo $ms | tr '\n' ' ')never names it" >&2
    done
  done
done 2> "${TMPDIR:-/tmp}/check-spine-plans.$$"
if [ -s "${TMPDIR:-/tmp}/check-spine-plans.$$" ]; then cat "${TMPDIR:-/tmp}/check-spine-plans.$$" >&2; fail=1; fi
rm -f "${TMPDIR:-/tmp}/check-spine-plans.$$"

[ "$fail" -eq 0 ] && echo "spine references OK"
exit "$fail"
