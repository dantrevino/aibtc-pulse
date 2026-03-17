// Agent Density — liveness + usefulness composite score
// GET /api/agent-density — returns count of agents with score >= threshold
// Score formula: recency(40%) + messaging(25%) + onChain(20%) + capability(15%)

const API_BASE = 'https://aibtc.com/api';
const MEMPOOL_BASE = 'https://mempool.space/api';
const CACHE_KEY = 'agent_density';
const CACHE_TTL = 900; // 15 minutes
const FETCH_TIMEOUT = 8000;

const HEADERS = {
  'Cache-Control': 'public, max-age=300',
  'Access-Control-Allow-Origin': '*',
};

// Rate limiting state
const rateLimiter = {
  requests: new Map(),
  maxRequests: 50,
  windowMs: 60000,
  check(key) {
    const now = Date.now();
    const window = this.requests.get(key) || { count: 0, resetAt: now + this.windowMs };
    if (now > window.resetAt) {
      window.count = 0;
      window.resetAt = now + this.windowMs;
    }
    if (window.count >= this.maxRequests) {
      return false;
    }
    window.count++;
    this.requests.set(key, window);
    
    // Cleanup: remove keys older than 2x window
    const cutoff = now - (this.windowMs * 2);
    for (const [k, v] of this.requests.entries()) {
      if (v.resetAt < cutoff) this.requests.delete(k);
    }
    return true;
  }
};

async function fetchJSON(url, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'aibtc-dashboard/1.0' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return res.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      console.error(`Timeout fetching ${url}`);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Safely parse a timestamp, returning 0 on invalid dates
function parseTimestamp(ts) {
  if (!ts) return 0;
  try {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  } catch {
    return 0;
  }
}

// Fetch BTC balance from mempool.space
async function getBtcBalance(btcAddress) {
  try {
    const data = await fetchJSON(`${MEMPOOL_BASE}/address/${btcAddress}`);
    if (!data?.chain_stats) return 0;
    const funded = data.chain_stats.funded_txo_sum || 0;
    const spent = data.chain_stats.spent_txo_sum || 0;
    return funded - spent;
  } catch {
    return 0;
  }
}

// Fetch inbox messages for an agent (paginated)
async function fetchInboxMessages(btcAddress, maxPages = 5) {
  const allMessages = [];
  let offset = 0;
  const limit = 100;
  
  for (let page = 0; page < maxPages; page++) {
    const data = await fetchJSON(`${API_BASE}/inbox/${btcAddress}?limit=${limit}&offset=${offset}`, FETCH_TIMEOUT);
    const msgs = data?.inbox?.messages || [];
    allMessages.push(...msgs);
    if (!data?.inbox?.hasMore || msgs.length === 0) break;
    offset = data?.inbox?.nextOffset ?? (offset + limit);
  }
  return allMessages;
}

// Calculate check-in recency score (40% weight)
// Full score if last check-in within 24h, decays linearly to 0 over 7 days
function calculateRecencyScore(lastActiveAt) {
  const lastActive = parseTimestamp(lastActiveAt);
  if (lastActive === 0) return 0;
  
  const now = Date.now();
  const hoursSinceActive = (now - lastActive) / (1000 * 60 * 60);
  
  if (hoursSinceActive <= 24) return 1.0;
  if (hoursSinceActive >= 168) return 0; // 7 days
  
  // Linear decay from 24h to 7 days
  return Math.max(0, 1 - (hoursSinceActive - 24) / (168 - 24));
}

// Calculate message activity score (25% weight)
// Normalized by max messages across all agents
function calculateMessagingScore(messages, maxMessages) {
  if (!messages || messages.length === 0) return 0;
  const now = Date.now();
  const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
  
  // Count messages in last 7 days (both sent and received)
  const recentMessages = messages.filter(m => {
    const sentAt = parseTimestamp(m.sentAt);
    return sentAt > 0 && sentAt >= sevenDaysAgo;
  });
  
  if (maxMessages === 0) return recentMessages.length > 0 ? 0.5 : 0;
  return Math.min(1, recentMessages.length / maxMessages);
}

// Calculate on-chain activity score (20% weight)
// Normalized by max BTC balance across all agents
function calculateOnChainScore(balance, maxBalance) {
  if (!balance || balance <= 0) return 0;
  if (maxBalance === 0) return 0.5;
  return Math.min(1, balance / maxBalance);
}

// Calculate capability depth score (15% weight)
// Based on level + achievements unlocked
function calculateCapabilityScore(agent) {
  // Level scores: Genesis (2) = 1.0, Registered (1) = 0.6, Guest/Unverified (0) = 0.2
  const levelScores = { 2: 1.0, 1: 0.6, 0: 0.2 };
  const levelScore = levelScores[agent.level] ?? 0.2;
  
  // Achievement bonus: up to 0.4 for having achievements
  const achievementCount = agent.achievements?.length || agent.achievementCount || 0;
  const achievementBonus = Math.min(0.4, achievementCount * 0.1);
  
  return Math.min(1, levelScore + achievementBonus);
}

// Calculate composite score for an agent
function calculateAgentScore(agent, balance, messages, maxBalance, maxMessages) {
  const recency = calculateRecencyScore(agent.lastActiveAt);
  const messaging = calculateMessagingScore(messages, maxMessages);
  const onChain = calculateOnChainScore(balance, maxBalance);
  const capability = calculateCapabilityScore(agent);
  
  const composite = (recency * 0.40) + (messaging * 0.25) + (onChain * 0.20) + (capability * 0.15);
  
  return {
    composite: Math.round(composite * 100) / 100,
    breakdown: {
      recency: Math.round(recency * 100) / 100,
      messaging: Math.round(messaging * 100) / 100,
      onChain: Math.round(onChain * 100) / 100,
      capability: Math.round(capability * 100) / 100,
    }
  };
}

export async function onRequest(context) {
  const kv = context.env?.PULSE_KV;
  const url = new URL(context.request.url);
  const skipCache = url.searchParams.get('fresh') === 'true';
  const threshold = parseFloat(url.searchParams.get('threshold') || '0.3');

  // Check cache first (skip if ?fresh=true)
  if (kv && !skipCache) {
    try {
      const cached = await kv.get(CACHE_KEY, { type: 'json' });
      if (cached) {
        return Response.json({ ...cached, cached: true }, { headers: HEADERS });
      }
    } catch (e) {
      // KV read failed, proceed
    }
  }

  try {
    // Fetch leaderboard with agent data
    const lb = await fetchJSON(API_BASE + '/leaderboard');
    if (!lb?.leaderboard) {
      return Response.json({ error: 'Failed to fetch leaderboard' }, { status: 502 });
    }

    const agents = lb.leaderboard;
    const now = Date.now();
    const SEVEN_DAYS = 7 * 86400000;

    // Pre-fetch all inbox messages to calculate max messages
    // Limit to active agents to avoid rate limits
    const activeAgents = agents.filter(a =>
      a.btcAddress &&
      a.lastActiveAt &&
      (now - new Date(a.lastActiveAt).getTime()) < SEVEN_DAYS
    );

    // Rate limit check - use time-windowed key
    const rateLimitKey = 'inbox_global';
    if (!rateLimiter.check(rateLimitKey)) {
      return Response.json({ 
        error: 'Rate limit exceeded. Please try again later.',
        retryAfter: 60 
      }, { status: 429, headers: { 'Retry-After': '60' } });
    }

    // Collect inbox messages for all active agents
    const inboxData = new Map(); // btcAddress -> messages[]
    const BATCH_SIZE = 6;
    
    for (let i = 0; i < activeAgents.length; i += BATCH_SIZE) {
      const batch = activeAgents.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (agent) => {
          const messages = await fetchInboxMessages(agent.btcAddress);
          return { btcAddress: agent.btcAddress, messages };
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value?.btcAddress) {
          inboxData.set(r.value.btcAddress, r.value.messages);
        }
      }
    }

    // Calculate max messages for normalization
    let maxMessages = 0;
    for (const messages of inboxData.values()) {
      const now = Date.now();
      const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
      const recentCount = messages.filter(m => {
        const sentAt = m.sentAt ? new Date(m.sentAt).getTime() : 0;
        return sentAt >= sevenDaysAgo;
      }).length;
      if (recentCount > maxMessages) maxMessages = recentCount;
    }

    // Fetch BTC balances and calculate scores
    const agentsWithScores = [];
    
    for (let i = 0; i < activeAgents.length; i += BATCH_SIZE) {
      const batch = activeAgents.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (agent) => {
          const balance = await getBtcBalance(agent.btcAddress);
          const messages = inboxData.get(agent.btcAddress) || [];
          return { agent, balance, messages };
        })
      );

      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const { agent, balance, messages } = r.value;
        
        // Store for later normalization
        agentsWithScores.push({ agent, balance, messages, balanceProcessed: false });
      }
    }

    // Calculate max balance for normalization
    const maxBalance = Math.max(...agentsWithScores.map(a => a.balance), 1);

    // Calculate final scores
    const scoredAgents = agentsWithScores.map(({ agent, balance, messages }) => {
      const score = calculateAgentScore(agent, balance, messages, maxBalance, maxMessages);
      return {
        displayName: agent.displayName,
        btcAddress: agent.btcAddress,
        level: agent.level,
        levelName: agent.levelName,
        score: score.composite,
        breakdown: score.breakdown,
        balance,
        lastActiveAt: agent.lastActiveAt,
        checkInCount: agent.checkInCount || 0,
        achievements: agent.achievements || [],
        achievementCount: agent.achievementCount || (agent.achievements?.length || 0),
      };
    });

    // Filter by threshold and sort by score
    const denseAgents = scoredAgents
      .filter(a => a.score >= threshold)
      .sort((a, b) => b.score - a.score);

    // Calculate average score
    const averageScore = scoredAgents.length > 0
      ? Math.round((scoredAgents.reduce((sum, a) => sum + a.score, 0) / scoredAgents.length) * 100) / 100
      : 0;

    const result = {
      density: denseAgents.length,
      densityThreshold: threshold,
      averageScore,
      scoreFormula: 'recency(40%) + messaging(25%) + onChain(20%) + capability(15%)',
      totalActive: activeAgents.length,
      totalAgents: agents.length,
      totalBtcSats: scoredAgents.reduce((sum, a) => sum + a.balance, 0),
      maxMessages,
      maxBalance,
      agents: scoredAgents,
      denseAgents: denseAgents.slice(0, 100), // Top 100 dense agents
      generatedAt: new Date().toISOString(),
    };

    // Update daily snapshots for history
    if (kv) {
      try {
        const pacificFmt = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Los_Angeles',
          year: 'numeric', month: '2-digit', day: '2-digit',
        });
        const today = pacificFmt.format(new Date());
        const raw = await kv.get('daily_snapshots', { type: 'json' });
        if (raw && raw[today]) {
          raw[today].density = denseAgents.length;
          raw[today].averageScore = averageScore;
          await kv.put('daily_snapshots', JSON.stringify(raw));
          await kv.delete('timeline_cache');
        }
      } catch (e) {
        // non-critical
      }
    }

    // Cache in KV
    if (kv) {
      try {
        await kv.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_TTL });
      } catch (e) {
        // continue
      }
    }

    return Response.json(result, { headers: HEADERS });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}