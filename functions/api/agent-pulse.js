// Agent Pulse — nudge agents with unread inbox messages via X
// POST /api/agent-pulse — identify agents with unread messages, tweet at their X handles
// POST /api/agent-pulse?dry=true — preview without posting
// POST /api/agent-pulse?target=rough+haven — target a specific agent by name

const API_BASE = 'https://aibtc.com/api';
const SELF_BTC = 'bc1q7zpy3kpxjzrfctz4en9k2h5sp8nwhctgz54sn5';
const COOLDOWN_DAYS = 7;
const MAX_TWEETS = 5;
const MIN_UNREAD = 1;
const MIN_STALE_MS = 1 * 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT = 8000; // 8s per fetch call

// ── OAuth 1.0a (shared pattern) ──
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

function buildAuthHeader(oauthParams) {
  return 'OAuth ' + Object.keys(oauthParams).sort().map(k =>
    `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`
  ).join(', ');
}

// ── Upload image to X via v1.1 media/upload ──
async function uploadMedia(imageBuffer, env) {
  const url = 'https://upload.twitter.com/1.1/media/upload.json';
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

  const formData = new FormData();
  formData.append('media', new Blob([imageBuffer], { type: 'image/png' }), 'agent.png');
  formData.append('media_category', 'tweet_image');

  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': buildAuthHeader(oauthParams),
      'User-Agent': 'AIBTCPulse/1.0',
    },
    body: formData,
  });

  const body = await res.json();
  return { status: res.status, body };
}

// ── Post tweet (with optional media) ──
async function postTweet(text, env, mediaId) {
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

  const body = { text };
  if (mediaId) {
    body.media = { media_ids: [mediaId] };
  }

  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': buildAuthHeader(oauthParams),
      'Content-Type': 'application/json',
      'User-Agent': 'AIBTCPulse/1.0',
    },
    body: JSON.stringify(body),
  });

  const resBody = await res.json();
  return { status: res.status, body: resBody };
}

const WORKER_URL = 'https://aibtc-pulse-cron.c3dar.workers.dev';

// ── Screenshot agent profile via worker (Puppeteer) ──
async function fetchAgentScreenshot(btcAddress) {
  try {
    const res = await fetch(`${WORKER_URL}/screenshot/${btcAddress}`, {
      headers: { 'User-Agent': 'AIBTCPulse/1.0' },
      signal: AbortSignal.timeout(25000), // screenshots take longer
    });
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

// ── Fetch all agents (paginated) ──
async function fetchAllAgents() {
  const agents = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const res = await fetch(`${API_BASE}/agents?limit=${limit}&offset=${offset}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'AIBTCPulse/1.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) break;
    const json = await res.json();
    const batch = json.agents || [];
    if (batch.length === 0) break;
    agents.push(...batch);
    if (!json.pagination?.hasMore) break;
    offset += limit;
  }

  return agents;
}

// ── Fetch inbox for an agent ──
async function fetchInbox(btcAddress) {
  try {
    const res = await fetch(`${API_BASE}/inbox/${btcAddress}?view=received`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'AIBTCPulse/1.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json.inbox?.messages || json.data || (Array.isArray(json) ? json : []);
  } catch {
    return [];
  }
}

// ── Extract X handle from agent owner field ──
function extractXHandle(agent) {
  const owner = agent.owner;
  if (!owner || typeof owner !== 'string') return null;
  const handle = owner.startsWith('@') ? owner.slice(1) : owner;
  if (!/^[a-zA-Z0-9_]{1,15}$/.test(handle)) return null;
  return handle;
}

// ── Cooldown check ──
function isOnCooldown(state, btcAddress) {
  const entry = state[btcAddress];
  if (!entry) return false;
  const cooldownEnd = new Date(entry.lastTweetedAt).getTime() + COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() < cooldownEnd;
}

// ── Build pulse tweet text ──
function buildPulseTweet(agent, xHandle, unreadCount, totalSats) {
  const name = agent.displayName || 'Unknown Agent';
  const plural = unreadCount !== 1 ? 's' : '';
  return [
    `${name} has recently earned ${totalSats} sats`,
    ``,
    `@${xHandle} make sure ${name} replies to it's ${unreadCount} unread message${plural} to keep building reputation and earning more btc!`,
    ``,
    `https://aibtc.com/agents/${agent.btcAddress}`,
  ].join('\n');
}

// ── Handler ──
export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return Response.json({
      endpoint: '/api/agent-pulse',
      method: 'POST',
      description: 'Nudge agents with unread inbox messages via X',
      params: {
        dry: '?dry=true — preview without posting',
        target: '?target=name — target a specific agent by display name',
        max: '?max=N — max tweets per run (default 5)',
      },
      requires: 'PULSE_KV binding + X API credentials',
    });
  }

  const env = context.env;
  const kv = env.PULSE_KV;

  if (!kv) {
    return Response.json({ error: 'PULSE_KV not bound' }, { status: 500 });
  }

  if (!env.X_API_KEY || !env.X_ACCESS_TOKEN) {
    return Response.json({ error: 'X API credentials not configured' }, { status: 500 });
  }

  const url = new URL(context.request.url);
  const isDryRun = url.searchParams.get('dry') === 'true';
  const targetFilter = url.searchParams.get('target')?.toLowerCase() || null;
  const maxTweets = parseInt(url.searchParams.get('max') || String(MAX_TWEETS), 10);

  try {
    // Load cooldown state from KV
    const stateRaw = await kv.get('agent_pulse_state');
    const state = stateRaw ? JSON.parse(stateRaw) : {};

    // Fetch all agents
    const allAgents = await fetchAllAgents();
    if (allAgents.length === 0) {
      return Response.json({ error: 'No agents found from API' });
    }

    // Apply target filter
    const agents = targetFilter
      ? allAgents.filter(a => a.displayName?.toLowerCase().includes(targetFilter) || a.btcAddress?.toLowerCase() === targetFilter)
      : allAgents;

    // Filter candidates
    const candidates = agents.filter(a => {
      if (!a.btcAddress) return false;
      if (!targetFilter && a.btcAddress === SELF_BTC) return false;
      if (isOnCooldown(state, a.btcAddress)) return false;
      if (!extractXHandle(a)) return false;
      return true;
    });

    // Check inboxes in parallel batches of 6 (same pattern as other functions)
    const targets = [];
    const BATCH_SIZE = 6;
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const inboxResults = await Promise.all(
        batch.map(async (agent) => {
          const messages = await fetchInbox(agent.btcAddress);
          const unread = messages.filter(m => m.readAt === null || m.readAt === undefined);
          return { agent, unread };
        })
      );
      const now = Date.now();
      for (const { agent, unread } of inboxResults) {
        // Only count messages unread for at least 2 hours
        const stale = unread.filter(m => {
          const sentAt = m.sentAt ? new Date(m.sentAt).getTime() : 0;
          return (now - sentAt) >= MIN_STALE_MS;
        });
        if (stale.length < MIN_UNREAD) continue;
        const totalSats = stale.reduce((sum, m) => sum + (m.paymentSatoshis || 0), 0);
        targets.push({
          agent,
          xHandle: extractXHandle(agent),
          unreadCount: stale.length,
          totalSats,
        });
      }
    }

    // Sort by sats descending, cap to max
    targets.sort((a, b) => b.totalSats - a.totalSats);
    const batch = targets.slice(0, maxTweets);

    if (batch.length === 0) {
      return Response.json({
        message: 'No targets with unread messages found',
        totalAgents: allAgents.length,
        filtered: agents.length,
        candidates: candidates.length,
      });
    }

    // Process each target
    const results = [];
    for (const target of batch) {
      const { agent, xHandle, unreadCount, totalSats } = target;
      const tweet = buildPulseTweet(agent, xHandle, unreadCount, totalSats);

      if (isDryRun) {
        const imageBuffer = await fetchAgentScreenshot(agent.btcAddress);
        results.push({
          agent: agent.displayName,
          btcAddress: agent.btcAddress,
          xHandle,
          unreadCount,
          totalSats,
          tweet,
          hasImage: !!imageBuffer,
          dryRun: true,
        });
        continue;
      }

      try {
        // Fetch OG image
        const imageBuffer = await fetchAgentScreenshot(agent.btcAddress);
        let mediaId = null;
        if (imageBuffer) {
          const upload = await uploadMedia(imageBuffer, env);
          if (upload.status === 200 || upload.status === 201) {
            mediaId = upload.body.media_id_string;
          }
        }

        // Post tweet
        const result = await postTweet(tweet, env, mediaId);
        const success = result.status === 201;

        if (success) {
          // Update cooldown state
          state[agent.btcAddress] = {
            lastTweetedAt: new Date().toISOString(),
            tweetId: result.body?.data?.id || null,
            unreadCount,
            satsEarned: totalSats,
          };
          await kv.put('agent_pulse_state', JSON.stringify(state));
        }

        results.push({
          agent: agent.displayName,
          btcAddress: agent.btcAddress,
          xHandle,
          unreadCount,
          totalSats,
          success,
          tweet,
          hasImage: !!mediaId,
          tweetId: result.body?.data?.id || null,
          x_response: result.body,
        });
      } catch (err) {
        results.push({
          agent: agent.displayName,
          btcAddress: agent.btcAddress,
          error: err.message,
        });
      }
    }

    return Response.json({
      totalAgents: allAgents.length,
      totalTargets: targets.length,
      processed: batch.length,
      dryRun: isDryRun,
      results,
    });
  } catch (err) {
    return Response.json({ error: err.message, stack: err.stack }, { status: 500 });
  }
}
