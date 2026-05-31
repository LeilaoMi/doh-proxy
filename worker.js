const upstream = "https://cloudflare-dns.com/dns-query";

function dnsHeaders(extra = {}) {
  return {
    "content-type": "application/dns-message",
    "cache-control": "no-store",
    ...extra,
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname !== "/dns-query") {
      return new Response("DoH endpoint: /dns-query", { status: 200 });
    }

    if (request.method === "GET") {
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

    if (request.method === "POST") {
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

    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, POST" },
    });
  },
};
