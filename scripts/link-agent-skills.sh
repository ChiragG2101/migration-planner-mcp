#!/bin/sh
# Link contributor skills from .agents/skills/ into tool folders that cannot read .agents/ directly.
# Today that is Claude Code, which reads skills only from .claude/skills/ but follows a symlink per skill.
# Idempotent: safe to rerun after pulling new skills. .claude/ is gitignored, so nothing here is committed.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
src="$root/.agents/skills"
dest="$root/.claude/skills"

[ -d "$src" ] || { echo "no skills in $src" >&2; exit 1; }
mkdir -p "$dest"

# Remove links that point into .agents/skills/ but whose target no longer exists.
for link in "$dest"/*; do
  [ -L "$link" ] || continue
  case "$(readlink "$link")" in
    *".agents/skills/"*) [ -e "$link" ] || { rm "$link"; echo "removed stale $(basename "$link")"; } ;;
  esac
done

for dir in "$src"/*/; do
  name=$(basename "$dir")
  [ -f "$dir/SKILL.md" ] || continue
  target="../../.agents/skills/$name"
  link="$dest/$name"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
    continue
  fi
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "skipped $name: $link exists and is not a symlink" >&2
    continue
  fi
  rm -f "$link"
  if ln -s "$target" "$link" 2>/dev/null && [ -f "$link/SKILL.md" ]; then
    echo "linked $name"
  else
    # Windows without symlink support: fall back to a copy. Rerun after editing skills.
    rm -rf "$link"; cp -R "$dir" "$link"; echo "copied $name (symlinks unavailable)"
  fi
done
