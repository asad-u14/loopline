#!/bin/bash
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0
[ -f docs/presentation.html ] || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

LAST=$(git log -1 --format=%H -- docs/presentation.html 2>/dev/null)
if [ -z "$LAST" ]; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:"docs/presentation.html exists but has never been committed. Commit an up-to-date presentation before pushing."}}'
  exit 0
fi

CHANGED=$(git log "$LAST"..HEAD --name-only --pretty=format: -- package.json CHANGELOG.md src/ 2>/dev/null | sort -u | grep -v '^$')
if [ -n "$CHANGED" ]; then
  LIST=$(echo "$CHANGED" | tr '\n' ',' | sed 's/,/, /g; s/, $//')
  jq -n --arg list "$LIST" --arg sha "${LAST:0:8}" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:("Source files changed since docs/presentation.html was last updated (commit " + $sha + "): " + $list + ". Refresh the presentation to reflect these changes before pushing.")}}'
fi
exit 0
