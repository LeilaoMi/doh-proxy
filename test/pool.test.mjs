// Unit tests for ECH-aware preferred-IP selection. Run: node --test test/
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { selectPoolIps, poolRequestUrl, getPreferredIps, handle, parseMessage, _resetMemo } from "../src/doh.js";

/** Build a pool row; `ech` is omitted entirely when undefined (old pool API). */
const row = (ip, carrier, ech, family = ip.includes(":") ? "v6" : "v4") => {
  const r = { ip, port: 443, carrier, family, delay: 50 };
  if (ech !== undefined) r.ech = ech;
  return r;
};

/** Request options as requestOptions() would produce them. */
const opts = (extra = {}) => ({ ip4: [], ip6: [], isp: null, ...extra });

/** Env with a mocked BESTIP binding serving `rows`; `seen` records requested URLs. */
function mockEnv(rows, extra = {}) {
  const seen = [];
  return {
    seen,
    env: {
      BEST_IP_URL: "https://bestip.example.com/api/ips?limit=60",
      BESTIP: {
        async fetch(req) {
          seen.push(req.url);
          return new Response(JSON.stringify({ ips: rows }), { headers: { "content-type": "application/json" } });
        },
      },
      ...extra,
    },
  };
}

beforeEach(() => _resetMemo());

test("ech:false IPs are skipped, even when they are the fastest", () => {
  const pool = [
    row("104.16.0.1", "CU", false),
    row("104.16.0.2", "CU", false),
    row("104.16.0.3", "CU", true),
    row("104.16.0.4", "CU", true),
  ];
  assert.deepEqual(selectPoolIps(pool, { family: "v4", isp: "cu", max: 4 }), ["104.16.0.3", "104.16.0.4"]);
});

test("an IP is dropped if any of its rows says ech:false", () => {
  const pool = [row("104.16.0.1", "CT", true), row("104.16.0.1", null, false), row("104.16.0.2", "CT", true)];
  assert.deepEqual(selectPoolIps(pool, { family: "v4", isp: "ct", max: 4 }), ["104.16.0.2"]);
});

test("tier order: own+true > untagged+true > own+unknown > untagged+unknown > other carrier", () => {
  const pool = [
    row("104.16.0.1", null, null), // untagged unknown
    row("104.16.0.2", "CU", null), // own unknown
    row("104.16.0.3", "CT", true), // other carrier true
    row("104.16.0.4", "CU", true), // own true
    row("104.16.0.5", null, true), // untagged true
    row("104.16.0.6", "CU"), // own, field missing
    row("104.16.0.7", "CU", false),
    row("104.16.0.8", "CM", null), // other carrier unknown
    row("104.16.0.9", "", true), // empty carrier = untagged
  ];
  assert.deepEqual(selectPoolIps(pool, { family: "v4", isp: "cu", max: 8 }), [
    "104.16.0.4",
    "104.16.0.5",
    "104.16.0.9",
    "104.16.0.2",
    "104.16.0.6",
    "104.16.0.1",
    "104.16.0.3",
    "104.16.0.8",
  ]);
  // Cut to max after ordering.
  assert.deepEqual(selectPoolIps(pool, { family: "v4", isp: "cu", max: 2 }), ["104.16.0.4", "104.16.0.5"]);
});

test("other-carrier ech:true ranks after own-carrier ech unknown", () => {
  const pool = [row("104.16.0.1", "CM", true), row("104.16.0.2", "CT", true), row("104.16.0.3", "CU", null), row("104.16.0.4", "CU")];
  assert.deepEqual(selectPoolIps(pool, { family: "v4", isp: "cu", max: 4 }), ["104.16.0.3", "104.16.0.4", "104.16.0.1", "104.16.0.2"]);
  assert.deepEqual(selectPoolIps(pool, { family: "v4", isp: "cu", max: 2 }), ["104.16.0.3", "104.16.0.4"]);
});

test("untagged rows rank before own-carrier unknown only when ech:true", () => {
  const pool = [row("104.16.0.1", null, null), row("104.16.0.2", "CU", null), row("104.16.0.3", undefined, true)];
  // untagged+true (tier 2) > own+unknown (tier 3) > untagged+unknown (tier 4)
  assert.deepEqual(selectPoolIps(pool, { family: "v4", isp: "cu", max: 4 }), ["104.16.0.3", "104.16.0.2", "104.16.0.1"]);
});

test("non-boolean ech values count as unknown", () => {
  const pool = [row("104.16.0.1", "CU", "true"), row("104.16.0.2", "CU", 1), row("104.16.0.3", "CU", true)];
  assert.deepEqual(selectPoolIps(pool, { family: "v4", isp: "cu", max: 4 }), ["104.16.0.3", "104.16.0.1", "104.16.0.2"]);
});

test("only other-carrier rows usable -> they still fill in (true first, then unknown)", () => {
  const pool = [
    row("104.16.0.1", "CU", false),
    row("104.16.0.2", null, false),
    row("104.16.0.3", "CT", null),
    row("104.16.0.4", "CM", true),
    row("104.16.0.5", "CT", true),
  ];
  assert.deepEqual(selectPoolIps(pool, { family: "v4", isp: "cu", max: 4 }), ["104.16.0.4", "104.16.0.5", "104.16.0.3"]);
});

test("duplicate IPs across tiers keep their best position", () => {
  const pool = [row("104.16.0.1", "CT", true), row("104.16.0.2", "CU", null), row("104.16.0.1", "CU", true)];
  assert.deepEqual(selectPoolIps(pool, { family: "v4", isp: "cu", max: 4 }), ["104.16.0.1", "104.16.0.2"]);
});

test("without ?isp= every row is the same tier: ech:true first, then unknown", () => {
  const pool = [row("104.16.0.1", "CU", null), row("104.16.0.2", "CT", true), row("104.16.0.3", null, false), row("104.16.0.4", "CM", true)];
  assert.deepEqual(selectPoolIps(pool, { family: "v4", max: 4 }), ["104.16.0.2", "104.16.0.4", "104.16.0.1"]);
});

test("address families are filtered independently", () => {
  const pool = [row("104.16.0.1", "CT", false), row("2606:4700::1", "CT", true), row("2606:4700::2", "CT", false), row("104.16.0.2", "CT", null)];
  assert.deepEqual(selectPoolIps(pool, { family: "v4", isp: "ct" }), ["104.16.0.2"]);
  assert.deepEqual(selectPoolIps(pool, { family: "v6", isp: "ct" }), ["2606:4700::1"]);
});

test("all ech:false -> empty (caller falls back to upstream IPs)", async () => {
  const pool = [row("104.16.0.1", "CU", false), row("104.16.0.2", null, false)];
  assert.deepEqual(selectPoolIps(pool, { family: "v4", isp: "cu" }), []);
  const { env } = mockEnv(pool);
  const got = await getPreferredIps(env, opts({ isp: "cu" }), { v4: true, v6: false });
  assert.deepEqual(got.v4, []);
});

test("old pool API without the ech field keeps the previous behaviour", () => {
  const pool = [row("104.16.0.1", "CT"), row("104.16.0.2", "CU"), row("104.16.0.3", "CU"), row("104.16.0.4"), row("2606:4700::1", "CU")];
  // Carrier rows first, in pool order, as before; then untagged, then other carriers.
  assert.deepEqual(selectPoolIps(pool, { family: "v4", isp: "cu", max: 2 }), ["104.16.0.2", "104.16.0.3"]);
  assert.deepEqual(selectPoolIps(pool, { family: "v4", isp: "cu", max: 4 }), ["104.16.0.2", "104.16.0.3", "104.16.0.4", "104.16.0.1"]);
  // No ?isp=: plain pool order.
  assert.deepEqual(selectPoolIps(pool, { family: "v4", max: 3 }), ["104.16.0.1", "104.16.0.2", "104.16.0.3"]);
  // Carrier not in pool: untagged first, then other carriers in pool order.
  assert.deepEqual(selectPoolIps(pool, { family: "v4", isp: "cm", max: 4 }), ["104.16.0.4", "104.16.0.1", "104.16.0.2", "104.16.0.3"]);
});

test("garbage input is tolerated", () => {
  assert.deepEqual(selectPoolIps(null, { family: "v4" }), []);
  assert.deepEqual(selectPoolIps([null, {}, { ip: "104.16.0.1" }], { family: "v4" }), []);
});

test("manual BEST_IPV4_<ISP> / BEST_IPV4 / ?ip4= are never ECH-filtered", async () => {
  const pool = [row("104.16.0.9", "CU", true)];
  // Manual IPs that the pool marks ech:false are still used verbatim.
  const bad = [row("104.16.0.1", "CU", false), row("104.16.0.2", "CU", false), ...pool];
  const a = mockEnv(bad, { BEST_IPV4_CU: "104.16.0.1,104.16.0.2" });
  assert.deepEqual((await getPreferredIps(a.env, opts({ isp: "cu" }), { v4: true, v6: false })).v4, ["104.16.0.1", "104.16.0.2"]);
  assert.equal(a.seen.length, 0, "pool not fetched when manual IPs cover the family");

  _resetMemo();
  const b = mockEnv(bad, { BEST_IPV4: "104.16.0.1" });
  assert.deepEqual((await getPreferredIps(b.env, opts(), { v4: true, v6: false })).v4, ["104.16.0.1"]);

  _resetMemo();
  const c = mockEnv(bad);
  assert.deepEqual((await getPreferredIps(c.env, opts({ ip4: ["104.16.0.2"] }), { v4: true, v6: false })).v4, ["104.16.0.2"]);
});

test("getPreferredIps uses the filtered pool and requests 200 rows with ech=1", async () => {
  const pool = [row("104.16.0.1", "CU", false), row("104.16.0.2", "CU", null), row("104.16.0.3", "CT", true), row("2606:4700::1", "CU", true)];
  const { env, seen } = mockEnv(pool);
  const got = await getPreferredIps(env, opts({ isp: "cu" }), { v4: true, v6: true });
  // Own-carrier unknown (0.2) ranks before other-carrier ech:true (0.3).
  assert.deepEqual(got, { v4: ["104.16.0.2", "104.16.0.3"], v6: ["2606:4700::1"] });
  assert.equal(seen.length, 1);
  const u = new URL(seen[0]);
  assert.equal(u.searchParams.get("limit"), "200");
  assert.equal(u.searchParams.get("ech"), "1");
});

test("poolRequestUrl: default, override, top removed, existing ech kept", () => {
  assert.equal(poolRequestUrl({}), "https://bestip.internal/api/ips?limit=200&ech=1");
  const u = new URL(poolRequestUrl({ BEST_IP_URL: "https://bestip.example.com/api/ips?top=60&carrier=CU", POOL_LIMIT: "120" }));
  assert.equal(u.searchParams.get("limit"), "120");
  assert.equal(u.searchParams.has("top"), false);
  assert.equal(u.searchParams.get("carrier"), "CU");
  assert.equal(new URL(poolRequestUrl({ BEST_IP_URL: "https://bestip.example.com/api/ips?ech=0" })).searchParams.get("ech"), "0");
  assert.equal(new URL(poolRequestUrl({ POOL_LIMIT: "abc" })).searchParams.get("limit"), "200");
});

// ---------- end to end through handle(): A answer with the pool filtered / falling back ----------
const UPSTREAM_IP = [104, 21, 1, 1]; // a Cloudflare address for the test name
/** Minimal upstream DoH answer: echoes the question, adds one A record for A queries. */
function fakeUpstream(query) {
  const q = new Uint8Array(query);
  const msg = parseMessage(q);
  const isA = msg.questions[0]?.type === 1;
  const head = Array.from(q.subarray(0, 12));
  head[2] = 0x81; head[3] = 0x80; // response, RD, RA, NOERROR
  head[6] = 0; head[7] = isA ? 1 : 0; // ancount
  head[10] = 0; head[11] = 0; // arcount
  let end = 12;
  while (q[end] !== 0) end += q[end] + 1;
  end += 5; // root label + qtype + qclass
  const out = [...head, ...q.subarray(12, end)];
  if (isA) out.push(0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...UPSTREAM_IP);
  return new Uint8Array(out);
}

/** Resolve www.example.com/A through handle() with a mocked upstream and pool; returns A data. */
async function resolveA(poolRows, query = "isp=cu") {
  _resetMemo();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Response(fakeUpstream(init.body), { headers: { "content-type": "application/dns-message" } });
  try {
    const { env } = mockEnv(poolRows, { ECH_PATH: "test-ech-path", CACHE: "off" });
    const res = await handle(new Request(`https://doh.example.com/test-ech-path/resolve?name=www.example.com&type=A&${query}`), env, {});
    const body = await res.json();
    return body.answers.map((a) => a.data);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("handle(): bad IPs are skipped in the A answer", async () => {
  const got = await resolveA([row("104.16.0.1", "CU", false), row("104.16.0.2", "CU", true)]);
  assert.deepEqual(got, ["104.16.0.2"]);
});

test("handle(): with ?isp=cu, a CU unknown IP beats a CT ech:true IP in the A answer", async () => {
  const got = await resolveA([row("104.16.0.1", "CT", true), row("104.16.0.2", "CU", null)]);
  assert.deepEqual(got, ["104.16.0.2", "104.16.0.1"]);
});

test("handle(): all pool IPs ech:false -> upstream's own A record, not rewritten to a bad IP", async () => {
  const got = await resolveA([row("104.16.0.1", "CU", false), row("104.16.0.2", "CT", false)]);
  assert.deepEqual(got, [UPSTREAM_IP.join(".")]);
});
