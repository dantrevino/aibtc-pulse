#!/bin/bash
# Wrapper script for SDK-native autonomous loop cycles
# Uses node llm/loop.mjs --once (SDK-based, no raw spawn)
# Logs start and end for debugging

LOG="/tmp/loop-wrapper.log"
echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) START pid=$$" >> "$LOG"

cleanup() {
    echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) END pid=$$" >> "$LOG"
    exit 0
}
trap cleanup SIGTERM SIGINT SIGHUP

exec WALLET_PASSWORD="${WALLET_PASS}" node llm/loop.mjs --once
