const upstream = "https://cloudflare-dns.com/dns-query";

function dnsHeaders(extra = {}) {
  return {
    "content-type": "application/dns-message",
    "cache-control": "no-store",
    ...extra,
  };
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const dns = url.searchParams.get("dns");

  if (!dns) {
    return new Response("ok", {
      status: 200,
      headers: { "content-type": "text/plain", "cache-control": "no-store" },
    });
  }

  const response = await fetch(`${upstream}?dns=${encodeURIComponent(dns)}`, {
    headers: { accept: "application/dns-message" },
  });

  return new Response(response.body, {
    status: response.status,
    headers: dnsHeaders(),
  });
}

export async function onRequestPost({ request }) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/dns-message")) {
    return new Response("Unsupported content-type", { status: 415 });
  }

  const response = await fetch(upstream, {
    method: "POST",
    headers: {
      accept: "application/dns-message",
      "content-type": "application/dns-message",
    },
    body: request.body,
  });

  return new Response(response.body, {
    status: response.status,
    headers: dnsHeaders(),
  });
}

export function onRequest() {
  return new Response("Method not allowed", {
    status: 405,
    headers: { allow: "GET, POST" },
  });
}
