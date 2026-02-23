// X (Twitter) OAuth 1.0a auto-poster for AIBTC Pulse
// POST /api/post-update — fetches live stats and posts to @aibtcpulse

const API_BASE = 'https://aibtc.com/api';

// ── OAuth 1.0a signature generation ──
async function hmacSha1(key, data) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function generateNonce() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

async function oauthSign(method, url, params, consumerSecret, tokenSecret) {
  const sortedParams = Object.keys(params).sort().map(k => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
  const baseString = `${method}&${percentEncode(url)}&${percentEncode(sortedParams)}`;
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return await hmacSha1(signingKey, baseString);
}

async function postTweet(text, env) {
  const url = 'https://api.x.com/2/tweets';
  const method = 'POST';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = generateNonce();

  const oauthParams = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };

  const signature = await oauthSign(method, url, oauthParams, env.X_API_SECRET, env.X_ACCESS_TOKEN_SECRET);
  oauthParams.oauth_signature = signature;

  const authHeader = 'OAuth ' + Object.keys(oauthParams).sort().map(k =>
    `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`
  ).join(', ');

  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'User-Agent': 'AIBTCPulse/1.0',
    },
    body: JSON.stringify({ text }),
  });

  const body = await res.json();
  return { status: res.status, body };
}

// ── Fetch live stats ──
async function fetchStats() {
  const [healthRes, lbRes] = await Promise.all([
    fetch(API_BASE + '/health', { headers: { 'Accept': 'application/json' } }).then(r => r.json()),
    fetch(API_BASE + '/leaderboard', { headers: { 'Accept': 'application/json' } }).then(r => r.json()),
  ]);

  const agents = lbRes.leaderboard || [];
  const agentCount = healthRes.services?.kv?.agentCount || agents.length;
  const genesisCount = healthRes.services?.kv?.claimedCount || 0;
  const totalCheckins = agents.reduce((sum, a) => sum + (a.checkInCount || 0), 0);

  // Fetch inbox totals
  let totalMessages = 0, totalSats = 0;
  const addrs = agents.map(a => a.btcAddress).filter(Boolean);
  const batchSize = 6;
  for (let i = 0; i < addrs.length; i += batchSize) {
    const batch = addrs.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(addr => fetch(API_BASE + '/inbox/' + addr, { headers: { 'Accept': 'application/json' } }).then(r => r.json()))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const msgs = r.value?.inbox?.messages || [];
        totalMessages += msgs.length;
        for (const m of msgs) totalSats += (m.paymentSatoshis || 0);
      }
    }
  }

  // Top agent
  const topAgent = agents[0]?.displayName || 'Unknown';
  const topScore = agents[0]?.score || 0;

  return { agentCount, genesisCount, totalCheckins, totalMessages, totalSats, topAgent, topScore };
}

// ── Build tweet text ──
function buildTweet(stats) {
  const { agentCount, genesisCount, totalCheckins, totalMessages, totalSats, topAgent, topScore } = stats;

  const lines = [
    `AIBTC Pulse — Network Update`,
    ``,
    `Agents: ${agentCount} (${genesisCount} Genesis)`,
    `Check-ins: ${totalCheckins.toLocaleString()}`,
    `Messages: ${totalMessages} via x402 inbox`,
    `Sats sent: ${totalSats.toLocaleString()}`,
    ``,
    `Top agent: ${topAgent} (${topScore.toLocaleString()} pts)`,
    ``,
    `https://aibtc-dashboard.pages.dev`,
  ];

  return lines.join('\n');
}

// ── Handler ──
export async function onRequest(context) {
  // Only allow POST
  if (context.request.method !== 'POST') {
    return Response.json({
      endpoint: '/api/post-update',
      method: 'POST',
      description: 'Fetches live AIBTC stats and posts to @aibtcpulse on X',
      auth: 'Requires X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET as secrets',
    });
  }

  try {
    // Check secrets exist
    const env = context.env;
    if (!env.X_API_KEY || !env.X_ACCESS_TOKEN) {
      return Response.json({ error: 'X API credentials not configured' }, { status: 500 });
    }

    // Fetch stats
    const stats = await fetchStats();

    // Build and post tweet
    const tweet = buildTweet(stats);
    const result = await postTweet(tweet, env);

    return Response.json({
      success: result.status === 201,
      tweet,
      x_response: result.body,
      stats,
    });
  } catch (err) {
    return Response.json({ error: err.message, stack: err.stack }, { status: 500 });
  }
}
