#!/usr/bin/env bash
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Run 'gh auth login' before using this script." >&2
  exit 1
fi

PRS=(1 2 3 4 5)

for pr in "${PRS[@]}"; do
  state="$(gh pr view "$pr" --json state,isDraft,mergeStateStatus --jq '.state + ":" + (.isDraft|tostring) + ":" + .mergeStateStatus')"
  pr_state="${state%%:*}"
  rest="${state#*:}"
  is_draft="${rest%%:*}"
  merge_status="${rest##*:}"

  if [[ "$pr_state" != "OPEN" ]]; then
    echo "PR #$pr is not OPEN (state=$pr_state)." >&2
    exit 1
  fi
  if [[ "$is_draft" != "false" ]]; then
    echo "PR #$pr is still a draft." >&2
    exit 1
  fi
  if [[ "$merge_status" != "CLEAN" && "$merge_status" != "HAS_HOOKS" && "$merge_status" != "UNSTABLE" ]]; then
    echo "PR #$pr is not merge-ready (mergeStateStatus=$merge_status)." >&2
    exit 1
  fi
done

for pr in "${PRS[@]}"; do
  echo "Merging PR #$pr..."
  gh pr merge "$pr" --merge --delete-branch
done

echo "Merged PRs #1 to #5 in order."
