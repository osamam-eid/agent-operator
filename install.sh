#!/usr/bin/env bash
# Agent Operator — install into the local OMP extensions directory.
set -euo pipefail
DEST="${HOME}/.omp/agent/extensions/agent-operator"
SRC="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mkdir -p "$DEST"
for entry in extension src schemas policies config scripts SKILL.md package.json; do
  cp -R "${SRC}/${entry}" "$DEST/"
done
echo "Agent Operator installed to ${DEST}"
echo "Restart OMP, then type /operator and press space for the command menu."
