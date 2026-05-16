// GET /api/load/:id
// Resp: stored payload JSON, or 404

const ID_PATTERN = /^[A-Za-z0-9]{4,12}$/;

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders
    }
  });
}

export async function onRequestGet(context) {
  const { params, env } = context;

  if (!env.PARTY_KV) {
    return jsonResponse({ error: 'KV binding PARTY_KV not configured' }, 500);
  }

  const id = params.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return jsonResponse({ error: 'Invalid id' }, 400);
  }

  let raw;
  try {
    raw = await env.PARTY_KV.get(id);
  } catch {
    return jsonResponse({ error: 'Storage failure' }, 500);
  }

  if (raw === null) {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  return new Response(raw, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60'
    }
  });
}
