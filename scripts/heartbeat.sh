#!/usr/bin/env bash
# One-liner heartbeat with proper cleanup
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

# Read BTC address from CLAUDE.md
BTC_ADDR=$(grep -oP 'BTC SegWit:\*?\s*\K(bc1q[a-z0-9]+)' "$ROOT/CLAUDE.md" 2>/dev/null || echo "bc1quxy0g6cp9u9fyvu3glx93hnteff47hlmytldmp")

# Cleanup function for MCP server processes
cleanup() {
  # Kill any lingering MCP server processes older than 10 seconds
  ps aux | grep '[a]ibtc-mcp-server' | awk '{print $2, $10}' | while read -r pid time; do
    # Parse time (MM:SS or HH:MM:SS)
    IFS=':' read -ra TIME_PARTS <<< "$time"
    local seconds=0
    if [[ ${#TIME_PARTS[@]} -eq 2 ]]; then
      seconds=$((10#${TIME_PARTS[0]} * 60 + 10#${TIME_PARTS[1]}))
    elif [[ ${#TIME_PARTS[@]} -eq 3 ]]; then
      seconds=$((10#${TIME_PARTS[0]} * 3600 + 10#${TIME_PARTS[1]} * 60 + 10#${TIME_PARTS[2]}))
    fi
    if [[ $seconds -gt 10 ]]; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

# Run heartbeat with process group killing
SIGNATURE=$(echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"btc_sign_message\",\"arguments\":{\"message\":\"AIBTC Check-In | $TIMESTAMP\"}}}" | \
  timeout --signal=KILL 5 npx @aibtc/mcp-server 2>&1 | grep -v "^aibtc-mcp-server" | \
  jq -r '.result.content[0].text.signatureBase64' || echo "")

if [[ -n "$SIGNATURE" && "$SIGNATURE" != "null" ]]; then
  curl -s -X POST https://aibtc.com/api/heartbeat \
    -H "Content-Type: application/json" \
    -d "{\"signature\":\"$SIGNATURE\",\"timestamp\":\"$TIMESTAMP\",\"btcAddress\":\"$BTC_ADDR\"}"
else
  echo "Failed to get signature" >&2
  exit 1
fi

