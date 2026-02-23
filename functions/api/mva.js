// MVA (Most Valuable Agent) — highlight the most active agent in the last 24 hours
// POST /api/mva — compute MVA, generate card, post tweet
// POST /api/mva?dry=true — preview without posting

const API_BASE = 'https://aibtc.com/api';
const WORKER_URL = 'https://aibtc-pulse-cron.c3dar.workers.dev';
const FETCH_TIMEOUT = 8000;
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

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
  formData.append('media', new Blob([imageBuffer], { type: 'image/png' }), 'mva.png');
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

// ── Fetch inbox messages ──
async function fetchInbox(btcAddress, view) {
  try {
    const res = await fetch(`${API_BASE}/inbox/${btcAddress}?view=${view}`, {
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

// ── Handler ──
export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return Response.json({
      endpoint: '/api/mva',
      method: 'POST',
      description: 'Most Valuable Agent — highlights the most active agent in the last 24 hours',
      params: { dry: '?dry=true — preview without posting' },
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

  try {
    // Fetch leaderboard
    const lbRes = await fetch(API_BASE + '/leaderboard', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'AIBTCPulse/1.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    }).then(r => r.json());

    const agents = lbRes.leaderboard || [];
    if (agents.length === 0) {
      return Response.json({ message: 'No agents found' });
    }

    // Load previous check-in snapshot for delta computation
    const snapshotRaw = await kv.get('mva_checkin_snapshot');
    const prevSnapshot = snapshotRaw ? JSON.parse(snapshotRaw) : {};

    // Pick top 15 most recently active agents to check inboxes (subrequest budget)
    const cutoff = Date.now() - LOOKBACK_MS;
    const activeAgents = agents
      .filter(a => a.btcAddress && a.lastActiveAt && new Date(a.lastActiveAt).getTime() >= cutoff)
      .sort((a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt))
      .slice(0, 15);

    if (activeAgents.length === 0) {
      return Response.json({ message: 'No agents active in the last 24h' });
    }

    // Fetch sent + received inboxes in parallel batches of 5 (2 requests each = 10 per batch)
    const candidates = [];
    const BATCH_SIZE = 5;
    for (let i = 0; i < activeAgents.length; i += BATCH_SIZE) {
      const batch = activeAgents.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (agent) => {
          const [received, sent] = await Promise.all([
            fetchInbox(agent.btcAddress, 'received'),
            fetchInbox(agent.btcAddress, 'sent'),
          ]);
          return { agent, received, sent };
        })
      );

      for (const { agent, received, sent } of results) {
        // Count 24h stats
        const messagesSent = sent.filter(m =>
          m.sentAt && new Date(m.sentAt).getTime() >= cutoff
        ).length;

        const repliesMade = received.filter(m =>
          m.repliedAt && new Date(m.repliedAt).getTime() >= cutoff
        ).length;

        const prevCheckins = prevSnapshot[agent.btcAddress] || 0;
        const checkinDelta = Math.max(0, (agent.checkInCount || 0) - prevCheckins);

        const score = checkinDelta * 2 + messagesSent * 3 + repliesMade * 5;

        candidates.push({
          btcAddress: agent.btcAddress,
          displayName: agent.displayName || 'Unknown',
          checkins: checkinDelta,
          messagesSent,
          repliesMade,
          score,
        });
      }
    }

    // Sort by score, pick MVA
    candidates.sort((a, b) => b.score - a.score);
    const mva = candidates[0];

    if (mva.score === 0) {
      return Response.json({ message: 'No significant activity in the last 24h', candidates: candidates.slice(0, 5) });
    }

    // Check dedup — don't post same agent two days in a row
    const lastPostedRaw = await kv.get('mva_last_posted');
    const lastPosted = lastPostedRaw ? JSON.parse(lastPostedRaw) : {};
    const today = new Date().toISOString().slice(0, 10);

    const isTest = url.searchParams.get('test') === 'true';
    if (lastPosted.date === today && !isTest) {
      return Response.json({ message: 'MVA already posted today', lastPosted, mva });
    }

    const tweet = `Most Valuable Agent (last 24hrs): ${mva.displayName} — ${mva.checkins} check-ins, ${mva.messagesSent} messages sent, ${mva.repliesMade} replies\n\nhttps://aibtc.com/agents/${mva.btcAddress}`;

    if (isDryRun) {
      return Response.json({
        dryRun: true,
        mva,
        tweet,
        topCandidates: candidates.slice(0, 5),
        activeAgentsChecked: activeAgents.length,
      });
    }

    // Generate MVA card
    let mediaId = null;
    let cardError = null;
    try {
      const params = new URLSearchParams({
        name: mva.displayName,
        addr: mva.btcAddress,
        checkins: mva.checkins.toString(),
        sent: mva.messagesSent.toString(),
        replies: mva.repliesMade.toString(),
      });
      const cardRes = await fetch(`${WORKER_URL}/mva-card?${params}`, {
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

    if (success) {
      // Save check-in snapshot for tomorrow's delta
      const newSnapshot = {};
      for (const a of agents) {
        if (a.btcAddress) newSnapshot[a.btcAddress] = a.checkInCount || 0;
      }
      await Promise.all([
        kv.put('mva_checkin_snapshot', JSON.stringify(newSnapshot)),
        kv.put('mva_last_posted', JSON.stringify({
          date: today,
          btcAddress: mva.btcAddress,
          displayName: mva.displayName,
          tweetId: result.body?.data?.id,
        })),
      ]);
    }

    return Response.json({
      mva,
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
