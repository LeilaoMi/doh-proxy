function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-max-age": "86400",
    ...extra,
  };
}

function jsonHeaders(extra = {}) {
  return corsHeaders({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    ...extra,
  });
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export function onRequestGet() {
  return new Response(JSON.stringify({
    status: "ok",
    service: "doh-proxy",
    endpoint: "/dns-query",
  }), { status: 200, headers: jsonHeaders() });
}

export function onRequest() {
  return new Response("Method not allowed", {
    status: 405,
    headers: corsHeaders({ allow: "GET, OPTIONS" }),
  });
}
