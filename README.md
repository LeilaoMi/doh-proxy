# doh-proxy

A tiny DNS-over-HTTPS (DoH) proxy for Cloudflare Workers and Cloudflare Pages Functions.

It exposes:

```text
/dns-query
```

and forwards DoH requests to:

```text
https://cloudflare-dns.com/dns-query
```

The endpoint supports both standard DoH request styles:

- `GET /dns-query?dns=...`
- `POST /dns-query` with `content-type: application/dns-message`

It also returns `200 ok` for a plain `GET /dns-query` health check, which helps clients such as Karing detect the endpoint as available.

## Why bind a custom domain?

Using the default `*.workers.dev` URL works, but some networks, apps, or proxy clients handle it poorly. A custom domain is usually more stable and easier to remember.

Recommended format:

```text
https://doh.example.com/dns-query
```

Use a **subdomain** such as `doh.example.com`, not the root domain, unless you intentionally want the root domain to only serve DoH.

## Deploy as a Cloudflare Worker

### 1. Install Wrangler

```bash
npm install -g wrangler
```

### 2. Log in

```bash
wrangler login
```

### 3. Deploy

```bash
wrangler deploy
```

Wrangler will print a URL like:

```text
https://doh-proxy.<your-workers-subdomain>.workers.dev
```

Your DoH endpoint is:

```text
https://doh-proxy.<your-workers-subdomain>.workers.dev/dns-query
```

### 4. Bind a custom domain, recommended

Add your domain to Cloudflare DNS first, then edit `wrangler.toml`:

```toml
routes = [
  { pattern = "doh.example.com", custom_domain = true }
]
```

Deploy again:

```bash
wrangler deploy
```

Then use:

```text
https://doh.example.com/dns-query
```

You can also bind once from the command line:

```bash
wrangler deploy --domain doh.example.com
```

## Deploy as Cloudflare Pages Functions

Pages Functions need a slightly different folder layout.

### 1. Create the Pages function file

Create this file:

```text
functions/dns-query.js
```

with this content:

```js
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
```

### 2. Add any static file

Cloudflare Pages expects a static output directory. For a minimal project, create:

```text
public/index.html
```

```html
<!doctype html>
<html>
  <body>DoH endpoint: /dns-query</body>
</html>
```

### 3. Deploy Pages

```bash
wrangler pages deploy public --project-name doh-proxy
```

The endpoint will be:

```text
https://<your-pages-project>.pages.dev/dns-query
```

### 4. Bind a custom domain, recommended

In Cloudflare Dashboard:

1. Open **Workers & Pages**.
2. Select your Pages project.
3. Go to **Custom domains**.
4. Add a subdomain such as `doh.example.com`.
5. Use:

```text
https://doh.example.com/dns-query
```

## Test

Health check:

```bash
curl -i https://doh.example.com/dns-query
```

Expected:

```text
HTTP/2 200
ok
```

DoH GET test:

```bash
python3 - <<'PY'
import base64, os, struct, urllib.request
qid = os.urandom(2)
q = bytearray(qid + b'\x01\x00' + struct.pack('!HHHH', 1, 0, 0, 0))
for part in 'example.com'.split('.'):
    q.append(len(part)); q.extend(part.encode())
q.append(0); q.extend(struct.pack('!HH', 1, 1))
dns = base64.urlsafe_b64encode(q).rstrip(b'=').decode()
url = 'https://doh.example.com/dns-query?dns=' + dns
req = urllib.request.Request(url, headers={'accept': 'application/dns-message'})
with urllib.request.urlopen(req, timeout=20) as r:
    data = r.read()
    print('status:', r.status)
    print('content-type:', r.headers.get('content-type'))
    print('valid response:', data[:2] == qid and (data[3] & 15) == 0)
PY
```

Replace `https://doh.example.com/dns-query` with your real endpoint.

## Client examples

v2rayNG / Karing remote DNS:

```text
https://doh.example.com/dns-query
```

For Karing, if proxy server checks fail, avoid using this DoH endpoint for **proxy server DNS**. Use system DNS, `1.1.1.1`, `8.8.8.8`, or a reliable bootstrap DNS for resolving the proxy server itself. Use this DoH endpoint for proxied traffic DNS.

## Current verified endpoint

```text
https://doh.leilaomi.ccwu.cc/dns-query
```
