// Network Milestone — tweet when agent count crosses a multiple of 10
// POST /api/milestone — check and post if milestone reached
// POST /api/milestone?dry=true — preview without posting
// POST /api/milestone?test=true — force post regardless of milestone check

const API_BASE = 'https://aibtc.com/api';
const WORKER_URL = 'https://aibtc-pulse-cron.c3dar.workers.dev';
const FETCH_TIMEOUT = 8000;
const MILESTONE_INTERVAL = 10;

// ── OAuth 1.0a ──
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

async function uploadMedia(imageBuffer, env) {
  const url = 'https://upload.twitter.com/1.1/media/upload.json';
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
  const signature = await oauthSign('POST', url, oauthParams, env.X_API_SECRET, env.X_ACCESS_TOKEN_SECRET);
  oauthParams.oauth_signature = signature;

  const formData = new FormData();
  formData.append('media', new Blob([imageBuffer], { type: 'image/png' }), 'milestone.png');
  formData.append('media_category', 'tweet_image');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': buildAuthHeader(oauthParams), 'User-Agent': 'AIBTCPulse/1.0' },
    body: formData,
  });
  return { status: res.status, body: await res.json() };
}

async function postTweet(text, env, mediaId) {
  const url = 'https://api.x.com/2/tweets';
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
  const signature = await oauthSign('POST', url, oauthParams, env.X_API_SECRET, env.X_ACCESS_TOKEN_SECRET);
  oauthParams.oauth_signature = signature;

  const body = { text };
  if (mediaId) body.media = { media_ids: [mediaId] };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': buildAuthHeader(oauthParams),
      'Content-Type': 'application/json',
      'User-Agent': 'AIBTCPulse/1.0',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ── Handler ──
export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return Response.json({
      endpoint: '/api/milestone',
      method: 'POST',
      description: 'Network milestone — tweets when agent count crosses a multiple of 10',
      params: {
        dry: '?dry=true — preview without posting',
        test: '?test=true — force post regardless of milestone check',
      },
    });
  }

  const env = context.env;
  const kv = env.PULSE_KV;
  if (!kv) return Response.json({ error: 'PULSE_KV not bound' }, { status: 500 });
  if (!env.X_API_KEY || !env.X_ACCESS_TOKEN) {
    return Response.json({ error: 'X API credentials not configured' }, { status: 500 });
  }

  const url = new URL(context.request.url);
  const isDryRun = url.searchParams.get('dry') === 'true';
  const isTest = url.searchParams.get('test') === 'true';

  try {
    // Fetch all agents (paginated) — includes owner field for X handle tags
    const agents = [];
    let offset = 0;
    while (true) {
      const res = await fetch(`${API_BASE}/agents?limit=50&offset=${offset}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'AIBTCPulse/1.0' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!res.ok) break;
      const json = await res.json();
      const batch = json.agents || [];
      if (batch.length === 0) break;
      agents.push(...batch);
      if (!json.pagination?.hasMore) break;
      offset += 50;
    }

    const totalCount = agents.length;

    if (totalCount === 0) {
      return Response.json({ message: 'No agents found' });
    }

    // Check if we've crossed a milestone
    const lastMilestoneRaw = await kv.get('milestone_last_count');
    const lastMilestone = lastMilestoneRaw ? parseInt(lastMilestoneRaw, 10) : 0;
    const currentMilestone = Math.floor(totalCount / MILESTONE_INTERVAL) * MILESTONE_INTERVAL;

    if (!isTest && currentMilestone <= lastMilestone) {
      return Response.json({
        message: `No new milestone — at ${totalCount} agents (last milestone: ${lastMilestone})`,
        totalCount,
        nextMilestone: lastMilestone + MILESTONE_INTERVAL,
      });
    }

    // Load previously posted agent addresses to avoid tagging same owner twice
    const postedAgentsRaw = await kv.get('milestone_posted_agents');
    const postedAgents = new Set(postedAgentsRaw ? JSON.parse(postedAgentsRaw) : []);

    // Get the newest agents not yet featured in a milestone
    const sortedByRecent = [...agents]
      .sort((a, b) => new Date(b.verifiedAt || 0) - new Date(a.verifiedAt || 0));

    const newAgents = sortedByRecent.filter(a => !postedAgents.has(a.btcAddress)).slice(0, 10);
    // Fall back to most recent if all have been posted
    const featured = newAgents.length > 0 ? newAgents : sortedByRecent.slice(0, 10);

    const recentAddrs = featured.map(a => a.btcAddress).filter(Boolean);
    const recentOwners = featured
      .map(a => a.owner)
      .filter(o => o && typeof o === 'string' && /^[a-zA-Z0-9_]{1,15}$/.test(o.replace('@', '')));
    const uniqueOwners = [...new Set(recentOwners.map(o => o.startsWith('@') ? o : `@${o}`))];

    const milestoneCount = isTest ? totalCount : currentMilestone;

    // Build tweet text
    const welcomeLine = uniqueOwners.length > 0 ? `\n\nWelcome to new agents from ${uniqueOwners.join(' ')}` : '';
    const tweet = `Milestone: ${milestoneCount} agents on the AIBTC network!${welcomeLine}\n\naibtc.com`;

    if (isDryRun) {
      return Response.json({
        dryRun: true,
        totalCount,
        milestoneCount,
        lastMilestone,
        recentAgents: sortedByRecent.map(a => ({ name: a.displayName, owner: a.owner })),
        tweet,
      });
    }

    // Generate milestone card
    let mediaId = null;
    let cardError = null;
    try {
      const params = new URLSearchParams({
        count: milestoneCount.toString(),
        addrs: recentAddrs.join(','),
      });
      const cardRes = await fetch(`${WORKER_URL}/milestone-card?${params}`, {
        headers: { 'User-Agent': 'AIBTCPulse/1.0' },
        signal: AbortSignal.timeout(35000),
      });
      if (cardRes.ok) {
        const cardImage = await cardRes.arrayBuffer();
        const upload = await uploadMedia(cardImage, env);
        if (upload.status === 200 || upload.status === 201) {
          mediaId = upload.body.media_id_string;
        } else {
          cardError = `upload failed: HTTP ${upload.status}`;
        }
      } else {
        cardError = `card fetch failed: HTTP ${cardRes.status}`;
      }
    } catch (err) {
      cardError = `card error: ${err.message}`;
    }

    // Post tweet
    const result = await postTweet(tweet, env, mediaId);
    const success = result.status === 201;

    if (success && !isTest) {
      // Track featured agents so they aren't tagged again in the next milestone
      for (const addr of recentAddrs) postedAgents.add(addr);
      await Promise.all([
        kv.put('milestone_last_count', currentMilestone.toString()),
        kv.put('milestone_posted_agents', JSON.stringify([...postedAgents])),
      ]);
    }

    return Response.json({
      milestoneCount,
      totalCount,
      tweet,
      hasImage: !!mediaId,
      cardError: cardError || undefined,
      success,
      tweetId: result.body?.data?.id || null,
      x_response: result.body,
    });
  } catch (err) {
    return Response.json({ error: err.message, stack: err.stack }, { status: 500 });
  }
}
