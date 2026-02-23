// Agent Density — active agents with BTC in their wallet
// GET /api/agent-density — returns count + list of active agents holding BTC
// Checks BTC balances via mempool.space, caches in PULSE_KV for 15 minutes

const API_BASE = 'https://aibtc.com/api';
const MEMPOOL_BASE = 'https://mempool.space/api';
const CACHE_KEY = 'agent_density';
const CACHE_TTL = 900; // 15 minutes

const HEADERS = {
  'Cache-Control': 'public, max-age=300',
  'Access-Control-Allow-Origin': '*',
};

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'aibtc-dashboard/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return res.json();
}

async function getBtcBalance(btcAddress) {
  try {
    const data = await fetchJSON(`${MEMPOOL_BASE}/address/${btcAddress}`);
    if (!data?.chain_stats) return 0;
    const funded = data.chain_stats.funded_txo_sum || 0;
    const spent = data.chain_stats.spent_txo_sum || 0;
    return funded - spent; // balance in sats
  } catch {
    return 0;
  }
}

export async function onRequest(context) {
  const kv = context.env?.PULSE_KV;
  const url = new URL(context.request.url);
  const skipCache = url.searchParams.get('fresh') === 'true';

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
    // Fetch leaderboard
    const lb = await fetchJSON(API_BASE + '/leaderboard');
    if (!lb?.leaderboard) {
      return Response.json({ error: 'Failed to fetch leaderboard' }, { status: 502 });
    }

    const agents = lb.leaderboard;
    const now = Date.now();
    const SEVEN_DAYS = 7 * 86400000;

    // Filter to active agents (active in last 7 days) with a BTC address
    const activeAgents = agents.filter(a =>
      a.btcAddress &&
      a.lastActiveAt &&
      (now - new Date(a.lastActiveAt).getTime()) < SEVEN_DAYS
    );

    // Check BTC balances in batches of 6
    const agentsWithBtc = [];
    const BATCH_SIZE = 6;

    for (let i = 0; i < activeAgents.length; i += BATCH_SIZE) {
      const batch = activeAgents.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (agent) => {
          const balance = await getBtcBalance(agent.btcAddress);
          return { agent, balance };
        })
      );

      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const { agent, balance } = r.value;
        if (balance > 0) {
          agentsWithBtc.push({
            displayName: agent.displayName,
            btcAddress: agent.btcAddress,
            balance,
            lastActiveAt: agent.lastActiveAt,
          });
        }
      }
    }

    // Sort by balance descending
    agentsWithBtc.sort((a, b) => b.balance - a.balance);

    const result = {
      density: agentsWithBtc.length,
      totalActive: activeAgents.length,
      totalAgents: agents.length,
      totalBtcSats: agentsWithBtc.reduce((sum, a) => sum + a.balance, 0),
      agents: agentsWithBtc,
      generatedAt: new Date().toISOString(),
    };

    // Write today's density into daily_snapshots so history.js includes it in timeline
    if (kv) {
      try {
        const pacificFmt = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Los_Angeles',
          year: 'numeric', month: '2-digit', day: '2-digit',
        });
        const today = pacificFmt.format(new Date());
        const raw = await kv.get('daily_snapshots', { type: 'json' });
        if (raw && raw[today]) {
          raw[today].density = agentsWithBtc.length;
          await kv.put('daily_snapshots', JSON.stringify(raw));
          // Invalidate timeline cache so history picks up the new density value
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
