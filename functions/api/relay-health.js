// Agent messaging pulse — 15-min message counts from all inboxes
// GET /api/relay-health — returns 15-min message volume for the pulse chart
// Always fetches fresh inbox data on cache miss so the chart is accurate
// Caches in PULSE_KV for 1 minute

const CACHE_KEY = 'relay_health';
const CACHE_TTL = 60; // 1 minute — keep pulse chart near-realtime
const BUCKET_MS = 15 * 60000; // 15-minute buckets
const EPOCH = Date.UTC(2026, 1, 12); // Feb 12, 2026 — network start

const HEADERS = {
  'Cache-Control': 'public, max-age=30',
  'Access-Control-Allow-Origin': '*',
};

function bucketKey(ts) {
  const d = new Date(ts);
  const q = Math.floor(d.getUTCMinutes() / 15) * 15;
  return d.toISOString().slice(0, 11)
    + String(d.getUTCHours()).padStart(2, '0') + ':'
    + String(q).padStart(2, '0');
}

export async function onRequest(context) {
  const kv = context.env?.PULSE_KV;
  const url = new URL(context.request.url);
  const skipCache = url.searchParams.get('fresh') === 'true';

  // Check cache
  if (kv && !skipCache) {
    try {
      const cached = await kv.get(CACHE_KEY, { type: 'json' });
      if (cached) {
        return Response.json({ ...cached, cached: true }, { headers: HEADERS });
      }
    } catch (e) { /* proceed */ }
  }

  const now = Date.now();
  const cutoff = EPOCH;

  // Always trigger a fresh inbox-aggregate fetch to get current message counts.
  // inbox_hourly is written as a side-effect of inbox-aggregate with no TTL,
  // so this ensures we always have the latest data when our cache misses.
  let inboxBuckets = {};
  try {
    const origin = new URL(context.request.url).origin;
    await fetch(origin + '/api/inbox-aggregate?fresh=true', {
      headers: { 'User-Agent': 'aibtc-dashboard/1.0' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) { /* continue — will read whatever is in KV */ }

  // Read the (now-fresh) bucket counts from KV
  if (kv) {
    try {
      const raw = await kv.get('inbox_hourly', { type: 'json' });
      if (raw) inboxBuckets = raw;
    } catch (e) { /* continue with empty */ }
  }

  // Build 15-min buckets for lookback window (inclusive of current bucket)
  const buckets = {};
  const totalBuckets = Math.ceil((now - cutoff) / BUCKET_MS) + 1;
  // Align cutoff to a 15-min boundary
  const alignedCutoff = Math.floor(cutoff / BUCKET_MS) * BUCKET_MS;
  for (let i = 0; i < totalBuckets; i++) {
    const ts = alignedCutoff + (i * BUCKET_MS);
    if (ts > now) break;
    const key = bucketKey(ts);
    buckets[key] = { hour: key, count: 0 };
  }

  // Fill from inbox bucket data
  for (const [key, count] of Object.entries(inboxBuckets)) {
    if (buckets[key]) {
      buckets[key].count = count;
    }
  }

  const hourlyArr = Object.values(buckets).sort((a, b) => a.hour.localeCompare(b.hour));

  // Extrapolate current partial bucket
  // If we're 5 min into a 15-min window with 3 msgs, project to ~9
  if (hourlyArr.length > 0) {
    const last = hourlyArr[hourlyArr.length - 1];
    const bucketStartKey = last.hour; // e.g. "2026-02-21T20:15"
    const parts = bucketStartKey.split(/[T:]/);
    const bucketStart = Date.UTC(
      parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]),
      parseInt(parts[3]), parseInt(parts[4])
    );
    const elapsed = now - bucketStart;
    if (elapsed > 60000 && elapsed < BUCKET_MS && last.count > 0) {
      last.projected = Math.round(last.count * (BUCKET_MS / elapsed));
    }
  }

  // Stats
  const nowKey = bucketKey(now);
  const oneDayAgoKey = bucketKey(now - 86400000);
  const oneHourAgoKey = bucketKey(now - 3600000);
  let messagesLast24h = 0, messagesLast1h = 0, totalInLookback = 0;
  for (const b of hourlyArr) {
    totalInLookback += b.count;
    if (b.hour >= oneDayAgoKey) messagesLast24h += b.count;
    if (b.hour >= oneHourAgoKey) messagesLast1h += b.count;
  }

  const result = {
    hourly: hourlyArr,
    stats: { totalInLookback, messagesLast1h, messagesLast24h },
    generatedAt: new Date(now).toISOString(),
    cached: false,
  };

  // Cache
  if (kv) {
    try {
      await kv.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_TTL });
    } catch (e) { /* continue */ }
  }

  return Response.json(result, { headers: HEADERS });
}
