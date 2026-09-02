#!/usr/bin/env bash
set -euo pipefail

if [[ "$(git rev-parse --is-bare-repository 2>/dev/null || true)" != "true" ]]; then
  echo "Run this script from a bare mirror clone; it will not rewrite a working checkout." >&2
  exit 2
fi

if ! command -v git-filter-repo >/dev/null 2>&1 && ! git filter-repo --help >/dev/null 2>&1; then
  echo "git-filter-repo is required: https://github.com/newren/git-filter-repo" >&2
  exit 2
fi

git filter-repo --force --invert-paths \
  --path resources/models/deepcw/en_tiny.onnx \
  --path resources/models/deepcw/en_small.onnx \
  --path resources/models/deepcw/README.md \
  --path resources/licenses/deepcw/NOTICE.txt \
  --path resources/licenses/deepcw/web-deep-cw-decoder-GPL-3.0-LICENSE \
  --path packages/web/public/models/en/39578E22-27CE-4AFB-989F-450345767A53

# git-filter-repo normally removes its temporary origin refs, but make the
# invariant explicit before object pruning in case this mirror was processed
# by another history-rewrite tool first.
while IFS= read -r ref; do
  git update-ref -d "$ref"
done < <(git for-each-ref --format='%(refname)' refs/original)

git reflog expire --expire=now --all
git gc --prune=now --quiet

if git rev-list --objects --all | rg -i 'resources/models/deepcw/(en_tiny|en_small)\.onnx|resources/licenses/deepcw|39578E22-27CE-4AFB-989F-450345767A53'; then
  echo "DeepCW history purge verification failed: an old path remains reachable." >&2
  exit 1
fi

echo "DeepCW history purge verified: old model/license/web paths are unreachable from all refs."
