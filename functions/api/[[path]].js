// Catch-all proxy for /api/* requests to aibtc.com
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const apiPath = url.pathname; // e.g. /api/health, /api/leaderboard, /api/inbox/...
  const target = 'https://aibtc.com' + apiPath + url.search;

  try {
    const res = await fetch(target, {
      method: context.request.method,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'aibtc-dashboard/1.0',
      },
    });

    const body = await res.text();

    return new Response(body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=30',
      },
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }
}
