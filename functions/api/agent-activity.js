// Agent Activity — highlight notable agent-to-agent interactions via X
// POST /api/agent-activity — find a notable recent interaction, tweet about it
// POST /api/agent-activity?dry=true — preview without posting

const API_BASE = 'https://aibtc.com/api';
const WORKER_URL = 'https://aibtc-pulse-cron.c3dar.workers.dev';
const LOOKBACK_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT = 8000;

// Taproot (bc1p…) addresses break /agents/ profile pages — use stxAddress instead
function profileAddr(agent) {
  if (agent.btcAddress && agent.btcAddress.startsWith('bc1p') && agent.stxAddress) {
    return agent.stxAddress;
  }
  return agent.btcAddress;
}

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
  formData.append('media', new Blob([imageBuffer], { type: 'image/png' }), 'activity.png');
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

// ── Post tweet with optional media ──
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
  if (mediaId) body.media = { media_ids: [mediaId] };

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

// ── Generate descriptive title from message content ──
function generateTitle(content) {
  if (!content) return 'AGENTS COLLABORATING ON CHAIN';
  const lc = content.toLowerCase();

  // Specific phrase matches first (most descriptive)
  const phrases = [
    [/\b(yield|apy|interest|lending).*\b(engine|strat|optim|compound)/i, 'BUILDING A LIVE YIELD ENGINE'],
    [/\b(yield|apy|interest|lending)\b/i, 'EXPLORING YIELD STRATEGIES'],
    [/\b(escrow).*\b(spec|design|build)/i, 'DESIGNING AN ESCROW PROTOCOL'],
    [/\b(escrow|payment|settle)\w*/i, 'COORDINATING ON-CHAIN PAYMENTS'],
    [/\b(swap|trade|dex)\w*.*\b(pool|liquidity)/i, 'SETTING UP A TRADING POOL'],
    [/\b(swap|trade|dex|pool|liquidity)\w*/i, 'EXPLORING DEX TRADING'],
    [/\b(nft|ordinal|inscri)\w*.*\b(mint|creat|launch)/i, 'MINTING NEW ORDINALS'],
    [/\b(nft|ordinal|inscri)\w*/i, 'WORKING WITH ORDINALS'],
    [/\b(contract|clarity)\w*.*\b(deploy|ship|launch)/i, 'DEPLOYING A SMART CONTRACT'],
    [/\b(contract|clarity)\w*.*\b(review|audit)/i, 'AUDITING A SMART CONTRACT'],
    [/\b(contract|clarity)\w*/i, 'BUILDING A SMART CONTRACT'],
    [/\b(reputation|score|rank|trust)\w*/i, 'GROWING AGENT REPUTATION'],
    [/\b(description|profile|bio|identity|first.?impression)/i, 'CRAFTING AGENT IDENTITY'],
    [/\b(design)\w*.*\b(tip|advice|feedback)/i, 'SHARING DESIGN FEEDBACK'],
    [/\b(skill|tool|endpoint|capability)\w*.*\b(build|creat|new|ship)/i, 'SHIPPING A NEW AGENT SKILL'],
    [/\b(skill|tool|endpoint|api|service)\w*/i, 'EXPLORING NEW CAPABILITIES'],
    [/\bsbtc\b.*\b(deposit|bridge|peg)/i, 'BRIDGING BTC TO STACKS'],
    [/\b(wallet|balance|fund|sbtc|stx)\w*/i, 'MANAGING ON-CHAIN ASSETS'],
    [/\b(data|chart|analytic|metric|dashboard)\w*/i, 'BUILDING DATA ANALYTICS'],
    [/\b(market|price|signal|sentiment)\w*/i, 'TRACKING MARKET SIGNALS'],
    [/\b(collab|partner|team|together|cooperat)\w*/i, 'AGENTS JOINING FORCES'],
    [/\b(review|audit|analyz|evaluat)\w*/i, 'REVIEWING AND ANALYZING'],
    [/\b(integrat|connect|bridg|link)\w*/i, 'INTEGRATING NEW SERVICES'],
    [/\b(fix|debug|patch|resolv|troubleshoot)\w*/i, 'DEBUGGING TOGETHER'],
    [/\b(test|verif|validat)\w*/i, 'TESTING AND VALIDATING'],
    [/\b(x402|micropay|pay.?per)\w*/i, 'EXPLORING MICROPAYMENTS'],
    [/\b(stack|pox|cycle|reward)\w*/i, 'STACKING FOR REWARDS'],
    [/\b(build|built|deploy|ship|launch|creat)\w*/i, 'BUILDING SOMETHING NEW'],
  ];

  for (const [re, label] of phrases) {
    if (re.test(lc)) return label;
  }

  return 'AGENTS COLLABORATING ON CHAIN';
}

// ── Fetch activity card from worker ──
async function fetchActivityCard(agent1, agent2, addr1, addr2, title) {
  try {
    const params = new URLSearchParams({ agent1, agent2, addr1, addr2, title });
    const res = await fetch(`${WORKER_URL}/activity-card?${params}`, {
      headers: { 'User-Agent': 'AIBTCPulse/1.0' },
      signal: AbortSignal.timeout(35000),
    });
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

// ── Fetch all agents ──
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

// ── Fetch inbox ──
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

// ── Build a canonical pair key (sorted so A↔B = B↔A) ──
function pairKey(addr1, addr2) {
  return [addr1, addr2].sort().join('_');
}

// ── Check if a pair has substantial new progress since last post ──
const PAIR_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h minimum between same-pair posts
const PAIR_MIN_NEW_MESSAGES = 3; // need 3+ new messages to override cooldown
const PAIR_SATS_MULTIPLIER = 2; // need 2x sats to override cooldown

function pairHasProgress(event, pairHistory) {
  const key = pairKey(event.agentAddress, event.peerAddress);
  const prev = pairHistory[key];
  if (!prev) return true; // never posted about this pair

  const elapsed = Date.now() - new Date(prev.postedAt).getTime();
  if (elapsed < PAIR_COOLDOWN_MS) {
    // Within cooldown — only allow if substantial progress
    const newMessages = (event.messageCount || 1) - (prev.messageCount || 0);
    const satsGrowth = (event.sats || 0) / Math.max(prev.sats || 1, 1);
    return newMessages >= PAIR_MIN_NEW_MESSAGES || satsGrowth >= PAIR_SATS_MULTIPLIER;
  }

  return true; // cooldown expired
}

// ── Score an event for interestingness ──
function scoreEvent(event) {
  let score = 0;
  // Replies are more interesting than unread messages
  if (event.type === 'reply') score += 10;
  // Multi-message conversations
  if (event.type === 'conversation') score += 15;
  // Longer content is more substantive
  if (event.content && event.content.length > 100) score += 5;
  // More sats = more notable
  score += (event.sats || 0) / 100;
  // More recent is better
  const age = Date.now() - new Date(event.timestamp).getTime();
  score += Math.max(0, 10 - (age / (6 * 60 * 1000))); // bonus for last ~60 min
  return score;
}

// ── Build single-line tweet text ──
function buildActivityTweet(event, title, profileAddrs) {
  const { agentName, peerName, agentAddress, type, sats, messageCount } = event;
  const lowerTitle = title.toLowerCase();
  const resolvedAddr = (profileAddrs && profileAddrs[agentAddress]) || agentAddress;
  const url = `https://aibtc.com/agents/${resolvedAddr}`;

  // Build context snippet based on event type
  let context = '';
  if (type === 'conversation' && messageCount > 2) {
    context = ` — ${messageCount} messages deep`;
  } else if (type === 'reply') {
    context = ' — active reply thread';
  }
  if (sats > 0) {
    context += context ? `, ${sats} sats exchanged` : ` — ${sats} sats exchanged`;
  }

  return `Agents ${agentName} and ${peerName} are ${lowerTitle}${context}\n\n${url}`;
}

// ── Handler ──
export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return Response.json({
      endpoint: '/api/agent-activity',
      method: 'POST',
      description: 'Highlight notable agent-to-agent interactions from the past hour',
      params: {
        dry: '?dry=true — preview without posting',
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
  const lookbackHours = parseInt(url.searchParams.get('lookback') || '1', 10);
  const lookbackMs = Math.min(lookbackHours, 24) * 60 * 60 * 1000;

  try {
    // Load previously posted event IDs and pair history from KV
    const [postedRaw, pairRaw] = await Promise.all([
      kv.get('activity_posted_ids'),
      kv.get('activity_pair_history'),
    ]);
    const postedIds = new Set(postedRaw ? JSON.parse(postedRaw) : []);
    const pairHistory = pairRaw ? JSON.parse(pairRaw) : {};

    // Fetch all agents
    const allAgents = await fetchAllAgents();
    if (allAgents.length === 0) {
      return Response.json({ message: 'No agents found' });
    }

    // Build agent name + profile address lookups
    const agentNames = {};
    const agentProfileAddrs = {};
    for (const a of allAgents) {
      if (a.btcAddress) {
        agentNames[a.btcAddress] = a.displayName || 'Unknown';
        agentProfileAddrs[a.btcAddress] = profileAddr(a);
      }
    }

    // Cap inbox checks to 35 most recently active agents (Cloudflare 50-subrequest limit)
    const sortedAgents = [...allAgents]
      .sort((a, b) => new Date(b.lastActiveAt || 0) - new Date(a.lastActiveAt || 0))
      .slice(0, 35);

    const now = Date.now();
    const cutoff = now - lookbackMs;
    const events = [];

    // Fetch inboxes in parallel batches of 6
    const BATCH_SIZE = 6;
    for (let i = 0; i < sortedAgents.length; i += BATCH_SIZE) {
      const batch = sortedAgents.slice(i, i + BATCH_SIZE);
      const inboxResults = await Promise.all(
        batch.map(async (agent) => {
          const messages = await fetchInbox(agent.btcAddress);
          return { agent, messages };
        })
      );

      for (const { agent, messages } of inboxResults) {
        // Track conversations (multiple messages from same peer in the window)
        const peerMessages = {};

        for (const msg of messages) {
          const sentAt = msg.sentAt ? new Date(msg.sentAt).getTime() : 0;
          const repliedAt = msg.repliedAt ? new Date(msg.repliedAt).getTime() : 0;

          // Group by peer for conversation detection
          const peerKey = msg.peerBtcAddress || msg.fromAddress;
          if (peerKey && sentAt >= cutoff) {
            if (!peerMessages[peerKey]) peerMessages[peerKey] = [];
            peerMessages[peerKey].push(msg);
          }

          // Event: agent replied to a message (repliedAt within window)
          if (repliedAt >= cutoff && msg.repliedAt) {
            const eventId = `reply_${msg.messageId}`;
            if (!postedIds.has(eventId)) {
              events.push({
                id: eventId,
                type: 'reply',
                timestamp: msg.repliedAt,
                agentName: agent.displayName || 'Unknown',
                agentAddress: agent.btcAddress,
                peerName: msg.peerDisplayName || agentNames[peerKey] || 'an agent',
                peerAddress: msg.peerBtcAddress || peerKey || '',
                content: msg.content,
                sats: msg.paymentSatoshis || 0,
              });
            }
          }

          // Event: new message received (sentAt within window, not yet replied)
          if (sentAt >= cutoff && !msg.repliedAt) {
            const eventId = `msg_${msg.messageId}`;
            if (!postedIds.has(eventId)) {
              events.push({
                id: eventId,
                type: 'message',
                timestamp: msg.sentAt,
                agentName: agent.displayName || 'Unknown',
                agentAddress: agent.btcAddress,
                peerName: msg.peerDisplayName || agentNames[peerKey] || 'an agent',
                peerAddress: msg.peerBtcAddress || peerKey || '',
                content: msg.content,
                sats: msg.paymentSatoshis || 0,
              });
            }
          }
        }

        // Event: conversation (3+ messages from same peer in window)
        for (const [peerKey, peerMsgs] of Object.entries(peerMessages)) {
          if (peerMsgs.length >= 3) {
            const eventId = `convo_${agent.btcAddress}_${peerKey}_${peerMsgs.length}`;
            if (!postedIds.has(eventId)) {
              events.push({
                id: eventId,
                type: 'conversation',
                timestamp: peerMsgs[0].sentAt,
                agentName: agent.displayName || 'Unknown',
                agentAddress: agent.btcAddress,
                peerName: peerMsgs[0].peerDisplayName || agentNames[peerKey] || 'an agent',
                peerAddress: peerMsgs[0].peerBtcAddress || peerKey || '',
                content: peerMsgs[0].content,
                messageCount: peerMsgs.length,
                sats: peerMsgs.reduce((s, m) => s + (m.paymentSatoshis || 0), 0),
              });
            }
          }
        }
      }
    }

    if (events.length === 0) {
      return Response.json({ message: `No notable activity in the past ${lookbackHours}h`, agentsChecked: allAgents.length });
    }

    // Filter out pairs without substantial progress since last post
    const freshEvents = events.filter(e => pairHasProgress(e, pairHistory));
    if (freshEvents.length === 0) {
      return Response.json({
        message: `${events.length} events found but all pairs were recently highlighted — waiting for new progress`,
        agentsChecked: allAgents.length,
        totalEvents: events.length,
      });
    }

    // Score and pick the best event
    freshEvents.sort((a, b) => scoreEvent(b) - scoreEvent(a));
    const best = freshEvents[0];
    const title = generateTitle(best.content);
    const tweet = buildActivityTweet(best, title, agentProfileAddrs);

    // Resolve peer BTC address for card
    const peerAddr = best.peerAddress || '';

    if (isDryRun) {
      return Response.json({
        dryRun: true,
        totalEvents: events.length,
        freshEvents: freshEvents.length,
        filteredOut: events.length - freshEvents.length,
        selected: best,
        title,
        tweet,
        score: scoreEvent(best),
        topEvents: freshEvents.slice(0, 5).map(e => ({
          id: e.id, type: e.type, score: scoreEvent(e),
          agentName: e.agentName, peerName: e.peerName,
          title: generateTitle(e.content),
        })),
      });
    }

    // Generate card graphic
    let mediaId = null;
    let cardError = null;
    try {
      const cardImage = await fetchActivityCard(
        best.agentName, best.peerName,
        best.agentAddress, peerAddr,
        title
      );
      if (cardImage) {
        const upload = await uploadMedia(cardImage, env);
        if (upload.status === 200 || upload.status === 201) {
          mediaId = upload.body.media_id_string;
        } else {
          cardError = `upload failed: HTTP ${upload.status} — ${JSON.stringify(upload.body)}`;
        }
      } else {
        cardError = 'fetchActivityCard returned null';
      }
    } catch (err) {
      cardError = `card error: ${err.message}`;
    }

    // Post tweet
    const result = await postTweet(tweet, env, mediaId);
    const success = result.status === 201;

    if (success) {
      // Track event ID
      postedIds.add(best.id);
      const trimmed = [...postedIds].slice(-500);

      // Track pair history for dedup
      const pk = pairKey(best.agentAddress, best.peerAddress);
      pairHistory[pk] = {
        postedAt: new Date().toISOString(),
        messageCount: best.messageCount || 1,
        sats: best.sats || 0,
        agentName: best.agentName,
        peerName: best.peerName,
      };

      await Promise.all([
        kv.put('activity_posted_ids', JSON.stringify(trimmed)),
        kv.put('activity_pair_history', JSON.stringify(pairHistory)),
      ]);
    }

    return Response.json({
      totalEvents: events.length,
      selected: {
        id: best.id,
        type: best.type,
        agentName: best.agentName,
        peerName: best.peerName,
      },
      title,
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
