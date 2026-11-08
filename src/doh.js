// doh-proxy core: plain DoH relay + optional ECH rewrite mode for Cloudflare-hosted sites.
// Shared by worker.js (Workers) and functions/*.js (Pages Functions).

const DEFAULT_UPSTREAM = "cloudflare-dns.com";
const DEFAULT_ECH_SOURCE = "cloudflare-ech.com";
const DEFAULT_ALPN = "h3,h2";
const DEFAULT_MAX_IPS = 4;
const REWRITE_TTL = 300;

const TYPE = { A: 1, CNAME: 5, AAAA: 28, OPT: 41, HTTPS: 65 };
const TYPE_NAMES = { 1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 15: "MX", 16: "TXT", 28: "AAAA", 41: "OPT", 64: "SVCB", 65: "HTTPS" };

// Cloudflare published ranges (cloudflare.com/ips-v4, ips-v6).
const CF_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];
const CF_V6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];

// ---------- headers ----------
function cors(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-max-age": "86400",
    ...extra,
  };
}
const NO_STORE = "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0";
const dnsHeaders = (x = {}) => cors({ "content-type": "application/dns-message", "cache-control": NO_STORE, ...x });
const textHeaders = (x = {}) => cors({ "content-type": "text/plain; charset=utf-8", "cache-control": NO_STORE, ...x });
const jsonHeaders = (x = {}) => cors({ "content-type": "application/json; charset=utf-8", "cache-control": NO_STORE, ...x });

// ---------- config ----------
export function getUpstream(env) {
  const value = String(env?.DOH_UPSTREAM || env?.DOH || DEFAULT_UPSTREAM).trim().replace(/\/+$/, "");
  if (/^https?:\/\//.test(value)) {
    const url = new URL(value);
    return `${url.origin}${url.pathname === "/" ? "/dns-query" : url.pathname}`;
  }
  return `https://${value}/dns-query`;
}
const on = (v) => /^(1|on|true|yes)$/i.test(String(v ?? "").trim());
const list = (v) => String(v ?? "").split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
// ECH endpoint is off unless ECH_PATH is set (keep it as a secret: `wrangler secret put ECH_PATH`).
const echPath = (env) => {
  const p = String(env?.ECH_PATH || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return p && !["dns-query", "health", "resolve"].includes(p) ? "/" + p : null;
};

// ---------- base64 ----------
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64Encode(bytes, url = false) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const s = btoa(bin);
  return url ? s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : s;
}
const b64Decode = (s) => b64urlDecode(s.replace(/=+$/, ""));

// ---------- DNS wire ----------
function readName(buf, off) {
  const labels = [];
  let jumped = false, end = off, guard = 0;
  while (guard++ < 128) {
    const len = buf[off];
    if (len === undefined) throw new Error("name out of range");
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      jumped = true;
      continue;
    }
    if (len === 0) { if (!jumped) end = off + 1; break; }
    labels.push(new TextDecoder().decode(buf.subarray(off + 1, off + 1 + len)));
    off += len + 1;
  }
  return { name: labels.join(".").toLowerCase(), end };
}

export function parseMessage(buf) {
  if (buf.length < 12) throw new Error("DNS message too short");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const msg = {
    id: dv.getUint16(0), flags: dv.getUint16(2),
    qd: dv.getUint16(4), an: dv.getUint16(6), ns: dv.getUint16(8), ar: dv.getUint16(10),
    questions: [], answers: [], authority: [], additional: [],
  };
  let off = 12;
  for (let i = 0; i < msg.qd; i++) {
    const { name, end } = readName(buf, off);
    msg.questions.push({ name, type: dv.getUint16(end), class: dv.getUint16(end + 2) });
    off = end + 4;
  }
  for (const [count, arr] of [[msg.an, msg.answers], [msg.ns, msg.authority], [msg.ar, msg.additional]]) {
    for (let i = 0; i < count; i++) {
      const { name, end } = readName(buf, off);
      const type = dv.getUint16(end), cls = dv.getUint16(end + 2), ttl = dv.getUint32(end + 4), len = dv.getUint16(end + 8);
      const start = end + 10;
      arr.push({ name, type, class: cls, ttl, rdata: buf.subarray(start, start + len), rdataOffset: start });
      off = start + len;
    }
  }
  msg.rcode = msg.flags & 0x0f;
  return msg;
}

function encodeName(name) {
  const parts = name.replace(/\.$/, "").split(".").filter(Boolean);
  const out = [];
  for (const p of parts) { const b = new TextEncoder().encode(p); out.push(b.length, ...b); }
  out.push(0);
  return out;
}
const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

function encodeRR({ name, type, cls = 1, ttl, rdata }) {
  return [...encodeName(name), ...u16(type), ...u16(cls), ...u32(ttl), ...u16(rdata.length), ...rdata];
}

export function buildQuery(name, type, id = 0, extraAdditional = []) {
  const bytes = [...u16(id), 0x01, 0x00, ...u16(1), 0, 0, 0, 0, ...u16(extraAdditional.length), ...encodeName(name), ...u16(type), 0, 1];
  for (const rr of extraAdditional) bytes.push(...rr);
  return new Uint8Array(bytes);
}

function buildResponse(reqMsg, question, answers, rcode = 0) {
  const rd = reqMsg.flags & 0x0100;
  const flags = 0x8000 | rd | 0x0080 | (rcode & 0x0f);
  const bytes = [...u16(reqMsg.id), ...u16(flags), ...u16(1), ...u16(answers.length), 0, 0, 0, 0,
    ...encodeName(question.name), ...u16(question.type), ...u16(question.class || 1)];
  for (const a of answers) bytes.push(...encodeRR(a));
  return new Uint8Array(bytes);
}

function withId(buf, id) {
  const out = new Uint8Array(buf);
  out[0] = (id >> 8) & 0xff; out[1] = id & 0xff;
  return out;
}

// ---------- IP helpers ----------
function v4ToInt(ip) { return ip.split(".").reduce((a, o) => ((a << 8) | (+o & 0xff)) >>> 0, 0); }
function v6ToBytes(ip) {
  let [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [], t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = ip.includes("::") ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(fill).fill("0"), ...t].map((g) => parseInt(g || "0", 16));
  const out = new Uint8Array(16);
  groups.forEach((g, i) => { out[i * 2] = g >> 8; out[i * 2 + 1] = g & 0xff; });
  return out;
}
function bytesToV6(b) {
  const g = [];
  for (let i = 0; i < 16; i += 2) g.push((((b[i] || 0) << 8) | (b[i + 1] || 0)).toString(16));
  let bestS = -1, bestL = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== "0") { i++; continue; }
    let j = i; while (j < 8 && g[j] === "0") j++;
    if (j - i > bestL && j - i > 1) { bestS = i; bestL = j - i; }
    i = j;
  }
  if (bestS < 0) return g.join(":");
  return g.slice(0, bestS).join(":") + "::" + g.slice(bestS + bestL).join(":");
}
function inCidr4(ip, cidr) {
  const [base, bits] = cidr.split("/");
  const mask = bits === "0" ? 0 : (~0 << (32 - +bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}
function inCidr6(bytes, cidr) {
  const [base, bitsS] = cidr.split("/");
  const b = v6ToBytes(base); let bits = +bitsS;
  for (let i = 0; i < 16 && bits > 0; i++, bits -= 8) {
    const m = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((bytes[i] & m) !== (b[i] & m)) return false;
  }
  return true;
}
export const isCfV4 = (ip) => CF_V4.some((c) => inCidr4(ip, c));
export const isCfV6 = (ip) => { const b = v6ToBytes(ip); return CF_V6.some((c) => inCidr6(b, c)); };
const isV4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
const isV6 = (s) => s.includes(":") && /^[0-9a-f:]+$/i.test(s);
const rdataA = (rd) => Array.from(rd).join(".");
const rdataAAAA = (rd) => bytesToV6(rd);

// ---------- ECS ----------
function ecsOption(clientIp) {
  if (!clientIp) return null;
  if (isV4(clientIp)) {
    const o = clientIp.split(".").map(Number).slice(0, 3);
    const data = [...u16(1), 24, 0, ...o];
    return { rr: [0, ...u16(TYPE.OPT), ...u16(4096), 0, 0, 0, 0, ...u16(4 + data.length), ...u16(8), ...u16(data.length), ...data], subnet: `${o.join(".")}.0/24` };
  }
  if (isV6(clientIp)) {
    const b = Array.from(v6ToBytes(clientIp).slice(0, 7));
    const data = [...u16(2), 56, 0, ...b];
    return { rr: [0, ...u16(TYPE.OPT), ...u16(4096), 0, 0, 0, 0, ...u16(4 + data.length), ...u16(8), ...u16(data.length), ...data], subnet: `${bytesToV6([...b, 0, 0, 0, 0, 0, 0, 0, 0, 0])}/56` }; // b holds the first 7 bytes (/56)
  }
  return null;
}

// ---------- upstream + cache ----------
const memo = new Map(); // small per-isolate cache for ECH config / IP pool

function cacheTtl(msg) {
  if (msg.rcode === 3) return 60;
  if (msg.rcode !== 0) return 0;
  const ttls = msg.answers.filter((r) => r.type !== TYPE.OPT).map((r) => r.ttl);
  if (!ttls.length) return 30;
  return Math.max(10, Math.min(300, Math.min(...ttls)));
}

async function upstreamQuery(env, ctx, origin, name, type, ecs) {
  const q = buildQuery(name, type, 0, ecs ? [ecs.rr] : []);
  const key = `${encodeURIComponent(name)}/${type}/${ecs ? encodeURIComponent(ecs.subnet) : "-"}`;
  return upstreamRaw(env, ctx, origin, q, key);
}

// Forward the client's own query bytes (EDNS/DO/CD/class preserved), id zeroed for cacheability.
async function upstreamForward(env, ctx, origin, query) {
  const q = withId(query, 0);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", q));
  return upstreamRaw(env, ctx, origin, q, "raw/" + b64Encode(digest, true));
}

async function upstreamRaw(env, ctx, origin, q, keyPart) {
  const cacheOn = !/^(0|off|false|no)$/i.test(String(env?.CACHE ?? "on"));
  const key = `${origin}/__dns_cache/${keyPart}`;
  const cache = cacheOn && typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  }
  const res = await fetch(getUpstream(env), {
    method: "POST",
    headers: { accept: "application/dns-message", "content-type": "application/dns-message", "cache-control": "no-store" },
    body: q,
  });
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (cache) {
    let ttl = 0;
    try { ttl = cacheTtl(parseMessage(buf)); } catch { ttl = 0; }
    if (ttl > 0) {
      const put = cache.put(key, new Response(buf, { headers: { "content-type": "application/dns-message", "cache-control": `max-age=${ttl}` } })).catch(() => {});
      ctx?.waitUntil ? ctx.waitUntil(put) : await put;
    }
  }
  return buf;
}

// ---------- ECH config ----------
function parseSvcParams(rdata) {
  const params = {};
  let off = 2; // priority
  off = skipName(rdata, off);
  const dv = new DataView(rdata.buffer, rdata.byteOffset, rdata.byteLength);
  while (off + 4 <= rdata.length) {
    const key = dv.getUint16(off), len = dv.getUint16(off + 2);
    params[key] = rdata.subarray(off + 4, off + 4 + len);
    off += 4 + len;
  }
  return { priority: dv.getUint16(0), params };
}
function skipName(buf, off) {
  while (off < buf.length && buf[off] !== 0) off += buf[off] + 1;
  if (off >= buf.length) throw new Error("truncated name in rdata");
  return off + 1;
}

async function getEchConfig(env, ctx, origin) {
  if (env?.ECH_CONFIG) return b64Decode(String(env.ECH_CONFIG).trim());
  const source = String(env?.ECH_SOURCE || DEFAULT_ECH_SOURCE).trim().toLowerCase();
  const m = memo.get("ech:" + source);
  if (m && m.exp > Date.now()) return m.val;
  const buf = await upstreamQuery(env, ctx, origin, source, TYPE.HTTPS, null);
  const msg = parseMessage(buf);
  for (const rr of msg.answers) {
    if (rr.type !== TYPE.HTTPS) continue;
    const ech = parseSvcParams(rr.rdata).params[5];
    if (ech?.length) {
      const val = new Uint8Array(ech);
      memo.set("ech:" + source, { val, exp: Date.now() + 30 * 60 * 1000 });
      return val;
    }
  }
  if (m) return m.val; // stale is better than nothing
  return null;
}

// ---------- preferred IP pool ----------
async function getPreferredIps(env, opts) {
  const max = Math.max(1, Math.min(8, +(env?.MAX_IPS || DEFAULT_MAX_IPS)));
  // Per-request overrides: ?ip4=a,b&ip6=c
  let v4 = opts.ip4.length ? opts.ip4 : list(env?.BEST_IPV4);
  let v6 = opts.ip6.length ? opts.ip6 : list(env?.BEST_IPV6);
  if (!opts.ip4.length && !v4.length && (env?.BESTIP || env?.BEST_IP_URL)) {
    const pool = await loadPool(env).catch(() => []);
    const pick = (fam) => {
      let rows = pool.filter((r) => r.family === fam);
      if (opts.isp) {
        const isp = rows.filter((r) => String(r.carrier || "").toLowerCase() === opts.isp);
        if (isp.length) rows = isp;
      }
      return [...new Set(rows.map((r) => r.ip))].slice(0, max);
    };
    v4 = pick("v4");
    if (!v6.length) v6 = pick("v6");
  }
  return { v4: v4.filter(isV4).slice(0, max), v6: v6.filter(isV6).slice(0, max) };
}

async function loadPool(env) {
  const m = memo.get("pool");
  if (m && m.exp > Date.now()) return m.val;
  const path = "/api/ips?limit=60";
  const res = env.BESTIP
    ? await env.BESTIP.fetch(new Request("https://bestip.internal" + path))
    : await fetch(String(env.BEST_IP_URL));
  if (!res.ok) throw new Error(`pool HTTP ${res.status}`);
  const data = await res.json();
  const val = (data.ips || []).filter((r) => r && r.ip && r.tested !== false);
  memo.set("pool", { val, exp: Date.now() + 10 * 60 * 1000 });
  return val;
}

// ---------- ECH rewrite ----------
function matchSuffix(name, suffixes) {
  return suffixes.some((s) => name === s || name.endsWith("." + s));
}

async function classify(env, ctx, origin, name, ecs) {
  if (matchSuffix(name, list(env?.ECH_EXCLUDE))) return { cf: false };
  if (matchSuffix(name, list(env?.ECH_FORCE))) return { cf: true, forced: true };
  const msg = parseMessage(await upstreamQuery(env, ctx, origin, name, TYPE.A, ecs));
  const ips = msg.answers.filter((r) => r.type === TYPE.A).map((r) => rdataA(r.rdata));
  if (ips.length) return { cf: ips.some(isCfV4), ips };
  // IPv6-only names: fall back to AAAA. (SOA/NS is deliberately NOT used: a Cloudflare zone
  // can hold DNS-only records that are not proxied, and rewriting those would break the site.)
  const m6 = parseMessage(await upstreamQuery(env, ctx, origin, name, TYPE.AAAA, ecs));
  const ips6 = m6.answers.filter((r) => r.type === TYPE.AAAA).map((r) => rdataAAAA(r.rdata));
  return { cf: ips6.length > 0 && ips6.some(isCfV6), ips: [] };
}

// ECH_ALPN_BY_ISP="ct:h3,h2;cu:h3,h2;cm:h2" -> per-carrier alpn when ?isp= is given.
// Workers cannot send UDP, so QUIC reachability cannot be probed here; this is a static per-carrier switch.
function alpnForIsp(env, isp) {
  if (!isp || !env?.ECH_ALPN_BY_ISP) return null;
  for (const part of String(env.ECH_ALPN_BY_ISP).split(";")) {
    const [k, v] = part.split(":");
    if (k && v && k.trim().toLowerCase() === isp) return v;
  }
  return null;
}

function httpsRdata({ alpn, v4, v6, ech }) {
  const params = [];
  if (alpn.length) {
    const val = [];
    for (const a of alpn) { const b = new TextEncoder().encode(a); val.push(b.length, ...b); }
    params.push([1, val]);
  }
  if (v4.length) params.push([4, v4.flatMap((ip) => ip.split(".").map(Number))]);
  if (ech?.length) params.push([5, Array.from(ech)]);
  if (v6.length) params.push([6, v6.flatMap((ip) => Array.from(v6ToBytes(ip)))]);
  const out = [...u16(1), 0];
  for (const [k, v] of params) out.push(...u16(k), ...u16(v.length), ...v);
  return out;
}

async function echResolve(env, ctx, origin, reqMsg, opts, ecs) {
  const q = reqMsg.questions[0];
  if (![TYPE.A, TYPE.AAAA, TYPE.HTTPS].includes(q.type)) return null;
  const info = await classify(env, ctx, origin, q.name, ecs);
  if (!info.cf) return null;

  const pref = await getPreferredIps(env, opts);
  const upstreamIps = async (type) => {
    const msg = parseMessage(await upstreamQuery(env, ctx, origin, q.name, type, ecs));
    return msg.answers.filter((r) => r.type === type).map((r) => (type === TYPE.A ? rdataA(r.rdata) : rdataAAAA(r.rdata)));
  };

  if (q.type === TYPE.A) {
    const ips = pref.v4.length ? pref.v4 : (info.ips?.length ? info.ips : await upstreamIps(TYPE.A));
    return { answers: ips.map((ip) => ({ name: q.name, type: TYPE.A, ttl: REWRITE_TTL, rdata: ip.split(".").map(Number) })), info: { cf: true, ips } };
  }
  if (q.type === TYPE.AAAA) {
    if (opts.no6) return { answers: [], info: { cf: true, ips: [] } };
    const ips = pref.v6.length ? pref.v6 : (await upstreamIps(TYPE.AAAA)).filter(isCfV6);
    return { answers: ips.map((ip) => ({ name: q.name, type: TYPE.AAAA, ttl: REWRITE_TTL, rdata: Array.from(v6ToBytes(ip)) })), info: { cf: true, ips } };
  }
  // HTTPS
  const ech = await getEchConfig(env, ctx, origin);
  const alpn = (opts.alpn ?? list(alpnForIsp(env, opts.isp) || env?.ECH_ALPN || DEFAULT_ALPN)).filter((a) => /^(h3|h2|http\/1\.1)$/.test(a));
  const v4 = pref.v4.length ? pref.v4 : [];
  const v6 = opts.no6 ? [] : pref.v6;
  const rdata = httpsRdata({ alpn, v4, v6, ech });
  return { answers: [{ name: q.name, type: TYPE.HTTPS, ttl: REWRITE_TTL, rdata }], info: { cf: true, ech: !!ech, alpn, v4, v6 } };
}

// ---------- request pipeline ----------
function requestOptions(url) {
  const p = url.searchParams;
  return {
    ip4: list(p.get("ip4")).filter(isV4),
    ip6: list(p.get("ip6")).filter(isV6),
    isp: (p.get("isp") || "").toLowerCase() || null, // ct / cu / cm
    alpn: p.has("alpn") ? list(p.get("alpn")) : null,
    no6: on(p.get("no6")),
  };
}

async function resolveWire(env, ctx, url, request, query, ech) {
  const reqMsg = parseMessage(query);
  const q = reqMsg.questions[0];
  const ecs = on(env?.ECS) ? ecsOption(request.headers.get("cf-connecting-ip")) : null;
  if (ech && q && reqMsg.qd === 1) {
    try {
      const r = await echResolve(env, ctx, url.origin, reqMsg, requestOptions(url), ecs);
      if (r) return { wire: buildResponse(reqMsg, q, r.answers), rewritten: true, info: r.info };
    } catch (e) {
      console.error("ECH rewrite failed, falling back:", e?.message || e);
    }
  }
  // ECS needs the query rebuilt with our OPT record; otherwise forward the client's bytes untouched.
  const buf = ecs && q && reqMsg.qd === 1
    ? await upstreamQuery(env, ctx, url.origin, q.name, q.type, ecs)
    : await upstreamForward(env, ctx, url.origin, query);
  return { wire: withId(buf, reqMsg.id), rewritten: false };
}

async function readQuery(request, url) {
  if (request.method === "GET") {
    const dns = url.searchParams.get("dns");
    return dns ? b64urlDecode(dns) : null;
  }
  const type = request.headers.get("content-type") || "";
  if (!type.includes("application/dns-message")) return "bad-type";
  return new Uint8Array(await request.arrayBuffer());
}

async function dohEndpoint(request, env, ctx, url, ech) {
  if (!["GET", "POST"].includes(request.method)) {
    return new Response("Method not allowed", { status: 405, headers: textHeaders({ allow: "GET, POST, OPTIONS" }) });
  }
  let query;
  try {
    query = await readQuery(request, url);
  } catch {
    return new Response("Bad DNS query", { status: 400, headers: textHeaders() });
  }
  if (query === null) return new Response("ok", { status: 200, headers: textHeaders() });
  if (query === "bad-type") return new Response("Unsupported content-type", { status: 415, headers: textHeaders() });
  try {
    const { wire, rewritten } = await resolveWire(env, ctx, url, request, query, ech);
    return new Response(wire, { status: 200, headers: dnsHeaders({ "x-doh-rewritten": rewritten ? "1" : "0" }) });
  } catch (e) {
    console.error("DoH error:", e?.message || e);
    if (String(e?.message || "").startsWith("upstream")) return new Response("Upstream DNS server error", { status: 503, headers: textHeaders() });
    return new Response("Bad DNS query", { status: 400, headers: textHeaders() });
  }
}

function describeRR(r) {
  const out = { name: r.name, type: TYPE_NAMES[r.type] || r.type, ttl: r.ttl };
  try {
    if (r.type === TYPE.A) out.data = rdataA(r.rdata);
    else if (r.type === TYPE.AAAA) out.data = rdataAAAA(r.rdata);
    else if (r.type === TYPE.HTTPS) {
      const { priority, params } = parseSvcParams(r.rdata);
      const d = { priority };
      if (params[1]) { const a = []; let o = 0; while (o < params[1].length) { const l = params[1][o]; a.push(new TextDecoder().decode(params[1].subarray(o + 1, o + 1 + l))); o += l + 1; } d.alpn = a; }
      if (params[4]) { const a = []; for (let o = 0; o < params[4].length; o += 4) a.push(Array.from(params[4].subarray(o, o + 4)).join(".")); d.ipv4hint = a; }
      if (params[5]) d.ech = b64Encode(params[5]);
      if (params[6]) { const a = []; for (let o = 0; o < params[6].length; o += 16) a.push(bytesToV6(params[6].subarray(o, o + 16))); d.ipv6hint = a; }
      out.data = d;
    } else out.data = b64Encode(r.rdata);
  } catch { out.data = null; }
  return out;
}

async function resolveJson(request, env, ctx, url) {
  const name = (url.searchParams.get("name") || "").trim().toLowerCase().replace(/\.$/, "");
  const typeS = (url.searchParams.get("type") || "A").toUpperCase();
  const type = TYPE[typeS] || +typeS;
  if (!name || !type) return new Response(JSON.stringify({ error: "usage: <ECH_PATH>/resolve?name=example.com&type=A|AAAA|HTTPS&mode=ech|plain" }), { status: 400, headers: jsonHeaders() });
  const ech = (url.searchParams.get("mode") || "ech").toLowerCase() === "ech";
  try {
    const { wire, rewritten, info } = await resolveWire(env, ctx, url, request, buildQuery(name, type, 0), ech);
    const msg = parseMessage(wire);
    return new Response(JSON.stringify({ name, type: typeS, mode: ech ? "ech" : "plain", rewritten, rcode: msg.rcode, info: info || null, answers: msg.answers.map(describeRR) }, null, 2), { status: 200, headers: jsonHeaders() });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 502, headers: jsonHeaders() });
  }
}

export async function handle(request, env = {}, ctx = {}) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  const ePath = echPath(env);
  if (url.pathname === "/") return new Response("DoH Proxy running. Endpoint: /dns-query", { status: 200, headers: textHeaders() });
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok", service: "doh-proxy", endpoint: "/dns-query" }), { status: 200, headers: jsonHeaders() });
  }
  const isDoh = url.pathname === "/dns-query" || (ePath && url.pathname === ePath);
  const isResolve = ePath && url.pathname === ePath + "/resolve" && request.method === "GET";
  if (!isDoh && !isResolve) return new Response("Not Found", { status: 404, headers: textHeaders() });
  // Optional per-IP rate limit (Workers Rate Limiting binding named RL).
  if (env?.RL?.limit) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const { success } = await env.RL.limit({ key: ip }).catch(() => ({ success: true }));
    if (!success) return new Response("Too Many Requests", { status: 429, headers: textHeaders({ "retry-after": "60" }) });
  }
  if (isResolve) return resolveJson(request, env, ctx, url);
  return dohEndpoint(request, env, ctx, url, url.pathname !== "/dns-query");
}
