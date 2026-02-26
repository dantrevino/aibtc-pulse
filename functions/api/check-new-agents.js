// New-agent detection + welcome tweet with PFP
// POST /api/check-new-agents — compares current agents against KV, tweets new arrivals
// POST /api/check-new-agents?seed=true — initializes KV without posting (first run)

const API_BASE = 'https://aibtc.com/api';

// ── OAuth 1.0a (shared with post-update.js) ──
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

  // OAuth signature — for multipart, body params are excluded from signature
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

  // Build multipart form with image binary
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

// ── Fetch welcome card from worker ──
async function fetchWelcomeCard(agent) {
  try {
    const levelNames = { 1: 'Registered', 2: 'Genesis' };
    const params = new URLSearchParams({
      name: agent.displayName || 'New Agent',
      addr: agent.btcAddress || '',
      levelNum: `${agent.level || 1}`,
      levelName: agent.levelName || levelNames[agent.level] || 'Registered',
    });
    const res = await fetch(`${WORKER_URL}/welcome-card?${params}`, {
      headers: { 'User-Agent': 'AIBTCPulse/1.0' },
      signal: AbortSignal.timeout(35000),
    });
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

// ── Resolve profile address (taproot bc1p… breaks /agents/ page, use stxAddress instead) ──
function profileAddress(agent) {
  if (agent.btcAddress && agent.btcAddress.startsWith('bc1p') && agent.stxAddress) {
    return agent.stxAddress;
  }
  return agent.btcAddress;
}

// ── Build welcome tweet ──
function buildWelcomeTweet(agent) {
  const name = agent.displayName || 'Unknown';
  const ownerTag = agent.owner ? ` by @${agent.owner}` : '';
  return `${name}${ownerTag} has joined the AIBTC network.\n\nhttps://aibtc.com/agents/${profileAddress(agent)}`;
}

// ── Handler ──
export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return Response.json({
      endpoint: '/api/check-new-agents',
      method: 'POST',
      description: 'Detects new AIBTC agents and posts welcome tweets with PFP',
      params: {
        seed: '?seed=true — initialize KV without posting (first run)',
        test: '?test=true — pick a random agent and post a test welcome tweet',
        dry: '?dry=true — detect new agents without posting (preview mode)',
      },
      requires: 'PULSE_KV binding + X API credentials',
    });
  }

  const env = context.env;
  const kv = env.PULSE_KV;

  if (!kv) {
    return Response.json({ error: 'PULSE_KV not bound — add KV binding in Pages settings' }, { status: 500 });
  }

  if (!env.X_API_KEY || !env.X_ACCESS_TOKEN) {
    return Response.json({ error: 'X API credentials not configured' }, { status: 500 });
  }

  try {
    // Fetch current agent list
    const lbRes = await fetch(API_BASE + '/leaderboard', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'AIBTCPulse/1.0' },
    }).then(r => r.json());

    const agents = lbRes.leaderboard || [];
    const currentAddrs = agents.map(a => a.btcAddress).filter(Boolean);

    // Read stored agents from KV
    const storedRaw = await kv.get('known_agents');
    const knownAddrs = new Set(storedRaw ? JSON.parse(storedRaw) : []);

    const url = new URL(context.request.url);
    const isSeed = url.searchParams.get('seed') === 'true';
    const isTest = url.searchParams.get('test') === 'true';
    const isDryRun = url.searchParams.get('dry') === 'true';

    // First run or explicit seed — store current list without posting
    if (!storedRaw || isSeed) {
      await kv.put('known_agents', JSON.stringify(currentAddrs));
      return Response.json({
        seeded: true,
        agentCount: currentAddrs.length,
        message: 'Initialized known agents list. Future calls will detect new agents.',
      });
    }

    // Test mode: pick a random agent to simulate a new arrival
    // Dry-run mode: detect new agents but don't tweet (just show what would be posted)
    let newAgents;
    if (isTest) {
      const idx = Math.floor(Math.random() * agents.length);
      newAgents = [agents[idx]];
    } else {
      newAgents = agents.filter(a => a.btcAddress && !knownAddrs.has(a.btcAddress));
    }

    if (newAgents.length === 0) {
      return Response.json({ newAgents: 0, message: 'No new agents detected.' });
    }

    // Post welcome tweet for each new agent
    const results = [];
    for (const agent of newAgents) {
      try {
        // Fetch welcome card from worker
        const imageBuffer = await fetchWelcomeCard(agent);

        let mediaId = null;
        if (imageBuffer) {
          const upload = await uploadMedia(imageBuffer, env);
          if (upload.status === 200 || upload.status === 201) {
            mediaId = upload.body.media_id_string;
          } else {
            results.push({
              agent: agent.displayName,
              mediaError: upload.body,
            });
          }
        }

        // Build tweet
        const tweet = buildWelcomeTweet(agent);

        if (isDryRun) {
          results.push({
            agent: agent.displayName,
            btcAddress: agent.btcAddress,
            tweet,
            hasImage: !!imageBuffer,
            imageSize: imageBuffer ? imageBuffer.byteLength : 0,
            dryRun: true,
          });
          continue;
        }

        // Post tweet
        const result = await postTweet(tweet, env, mediaId);

        results.push({
          agent: agent.displayName,
          btcAddress: agent.btcAddress,
          success: result.status === 201,
          tweet,
          hasImage: !!mediaId,
          x_response: result.body,
        });
      } catch (err) {
        results.push({ agent: agent.displayName, error: err.message });
      }
    }

    // Update stored agents with current full list (skip in test/dry mode)
    if (!isTest && !isDryRun) {
      await kv.put('known_agents', JSON.stringify(currentAddrs));
    }

    return Response.json({
      newAgents: newAgents.length,
      results,
      totalKnown: currentAddrs.length,
    });
  } catch (err) {
    return Response.json({ error: err.message, stack: err.stack }, { status: 500 });
  }
}
