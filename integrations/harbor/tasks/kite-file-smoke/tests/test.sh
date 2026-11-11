#!/bin/bash
set -euo pipefail
mkdir -p /logs/verifier
reward=0
if [ ! -f /app/answer.txt ]; then
  echo 'missing /app/answer.txt'
elif printf 'Kite Harbor adapter smoke passed\n' | cmp -s - /app/answer.txt; then
  reward=1
else
  echo 'unexpected /app/answer.txt contents'
fi
# The separate verifier must not see the agent runtime/image filesystem.
if [ -e /opt/kite ] || [ -e /opt/kite-harbor ]; then
  echo 'agent runtime leaked into verifier'
  reward=0
fi
printf '%s\n' "$reward" > /logs/verifier/reward.txt
