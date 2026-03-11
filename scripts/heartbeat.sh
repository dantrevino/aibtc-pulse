# One-liner heartbeat
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z") && \
echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"btc_sign_message\",\"arguments\":{\"message\":\"AIBTC Check-In | $TIMESTAMP\"}}}" | \
  timeout 5 npx @aibtc/mcp-server 2>&1 | grep -v "^aibtc-mcp-server" | \
  jq -r '.result.content[0].text.signatureBase64' | \
  xargs -I {} curl -s -X POST https://aibtc.com/api/heartbeat \
    -H "Content-Type: application/json" \
    -d "{\"signature\":\"{}\",\"timestamp\":\"$TIMESTAMP\",\"btcAddress\":\"bc1quxy0g6cp9u9fyvu3glx93hnteff47hlmytldmp\"}"

