#!/bin/bash
# Wrapper script to ensure clean exit of opencode loop cycles
# Logs start and end for debugging

LOG="/tmp/loop-wrapper.log"
echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) START pid=$$" >> "$LOG"

cleanup() {
    echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) END pid=$$" >> "$LOG"
    exit 0
}
trap cleanup SIGTERM SIGINT SIGHUP

exec /home/dan/.nvm/versions/node/v24.14.0/bin/opencode run \
  --dir /home/dan/aibtc \
  -f /home/dan/aibtc/CLAUDE.md \
  -f /home/dan/aibtc/SOUL.md \
  -f /home/dan/aibtc/daemon/loop.md \
  -f /home/dan/aibtc/daemon/STATE.md \
  -f /home/dan/aibtc/daemon/health.json \
  -- "Perform one autonomous cycle using wallet password ${WALLET_PASS}. Execute phases: heartbeat, inbox, decide, execute, deliver, outreach, write, and sync. Increment cycle number, then commit and push changes."
