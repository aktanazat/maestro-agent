#!/usr/bin/env bash
# Export this build's Claude Code session trace (native JSONL) for submission.
# The traces live at ~/.claude/projects/<slugified-cwd>/<session-uuid>.jsonl.
# Usage: scripts/export-session.sh [session-uuid]   (defaults to the most recent)
set -euo pipefail

PROJECT_DIR="$HOME/.claude/projects/-Users-aktanazat"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/submission"
mkdir -p "$OUT_DIR"

if [[ $# -ge 1 ]]; then
  SRC="$PROJECT_DIR/$1.jsonl"
else
  SRC="$(ls -t "$PROJECT_DIR"/*.jsonl | head -n1)"
fi

cp "$SRC" "$OUT_DIR/session-trace.jsonl"
echo "Exported $(basename "$SRC") -> submission/session-trace.jsonl"
echo "Lines: $(wc -l < "$OUT_DIR/session-trace.jsonl")"
echo "Attach submission/session-trace.jsonl to the email reply (kept out of the public repo by .gitignore)."
