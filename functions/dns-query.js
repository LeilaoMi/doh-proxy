const defaultUpstream = "cloudflare-dns.com";

function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-max-age": "86400",
    ...extra,
  };
}

function dnsHeaders(extra = {}) {
  return corsHeaders({
    "content-type": "application/dns-message",
    "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    ...extra,
  });
}

function textHeaders(extra = {}) {
  return corsHeaders({
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    ...extra,
  });
}

function getUpstream(env) {
  const value = (env?.DOH_UPSTREAM || env?.DOH || defaultUpstream).trim().replace(/\/+$/, "");
  if (value.startsWith("http://") || value.startsWith("https://")) {
    const url = new URL(value);
    return `${url.origin}${url.pathname === "/" ? "/dns-query" : url.pathname}`;
  }
  return `https://${value}/dns-query`;
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const dns = url.searchParams.get("dns");
  if (!dns) return new Response("ok", { status: 200, headers: textHeaders() });

  try {
    const response = await fetch(`${getUpstream(env)}?dns=${encodeURIComponent(dns)}`, {
      headers: { accept: "application/dns-message", "cache-control": "no-store" },
    });

    return new Response(response.body, { status: response.status, headers: dnsHeaders() });
  } catch (error) {
    console.error("Upstream DNS error:", error);
    return new Response("Upstream DNS server error", { status: 503, headers: textHeaders() });
  }
}

export async function onRequestPost({ request, env }) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/dns-message")) {
    return new Response("Unsupported content-type", { status: 415, headers: textHeaders() });
  }

  try {
    const response = await fetch(getUpstream(env), {
      method: "POST",
      headers: {
        accept: "application/dns-message",
        "content-type": "application/dns-message",
        "cache-control": "no-store",
      },
      body: request.body,
    });

    return new Response(response.body, { status: response.status, headers: dnsHeaders() });
  } catch (error) {
    console.error("Upstream DNS error:", error);
    return new Response("Upstream DNS server error", { status: 503, headers: textHeaders() });
  }
}

export function onRequest() {
  return new Response("Method not allowed", {
    status: 405,
    headers: textHeaders({ allow: "GET, POST, OPTIONS" }),
  });
}
