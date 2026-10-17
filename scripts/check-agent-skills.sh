#!/bin/sh
# Check contributor skills in .agents/skills/ follow the rules in .agents/README.md.
# Exits non-zero on any problem. Meant for CI and pre-commit.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
max_lines=120
allowed="name description license compatibility metadata allowed-tools"
fail=0
err() { echo "$1: $2" >&2; fail=1; }

for dir in "$root"/.agents/skills/*/; do
  name=$(basename "$dir")
  file="$dir/SKILL.md"
  [ -f "$file" ] || { err "$name" "missing SKILL.md"; continue; }

  [ "$(head -n 1 "$file")" = "---" ] || { err "$name" "frontmatter must start on line 1"; continue; }
  front=$(awk 'NR==1{next} /^---$/{exit} {print}' "$file")

  for key in $(printf '%s\n' "$front" | sed -n 's/^\([A-Za-z_-]*\):.*/\1/p'); do
    case " $allowed " in *" $key "*) ;; *) err "$name" "non-portable frontmatter field '$key'";; esac
  done

  fm_name=$(printf '%s\n' "$front" | sed -n 's/^name: *//p')
  [ "$fm_name" = "$name" ] || err "$name" "name '$fm_name' must match the folder name"

  desc=$(printf '%s\n' "$front" | sed -n 's/^description: *//p')
  case "$desc" in "Use when "*) ;; *) err "$name" "description must start with 'Use when'";; esac

  lines=$(wc -l < "$file" | tr -d ' ')
  [ "$lines" -le "$max_lines" ] || err "$name" "$lines lines (limit $max_lines); move detail into files next to SKILL.md"

  extra=$(find "$dir" -type f \( -name '*.sh' -o -name '*.js' -o -name '*.ts' -o -name '*.py' \) | head -n 1)
  [ -z "$extra" ] || err "$name" "skills hold instructions only, found script $(basename "$extra")"
done

[ "$fail" -eq 0 ] && echo "agent skills OK"
exit "$fail"
