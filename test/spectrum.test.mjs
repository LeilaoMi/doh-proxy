// Spectrum (pacloudflare.com) names sit on Cloudflare IPs but do not support ECH: never rewrite them.
// Run: node --test test/
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handle, parseMessage, skipByCname, _resetMemo } from "../src/doh.js";

const enc = (name) => name.split(".").flatMap((l) => [l.length, ...new TextEncoder().encode(l)]).concat(0);
const SPECTRUM_IP = [172, 65, 248, 248]; // Cloudflare range, but a Spectrum app
const POOL_IP = "104.16.0.9";

/** Upstream answer for an A query: CNAME to `target` (compressed owner) + A on `target`, or a plain A. */
function fakeUpstream(query, target) {
  const q = new Uint8Array(query);
  const msg = parseMessage(q);
  const isA = msg.questions[0]?.type === 1;
  const head = Array.from(q.subarray(0, 12));
  head[2] = 0x81; head[3] = 0x80;
  head[10] = 0; head[11] = 0;
  let end = 12;
  while (q[end] !== 0) end += q[end] + 1;
  end += 5;
  const out = [...q.subarray(12, end)];
  const answers = [];
  if (isA && target) {
    const t = enc(target);
    answers.push([0xc0, 0x0c, 0, 5, 0, 1, 0, 0, 0, 60, 0, t.length, ...t]);
    const tOff = 12 + out.length + 12; // where the CNAME rdata (target name) starts
    answers.push([0xc0 | (tOff >> 8), tOff & 0xff, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...SPECTRUM_IP]);
  } else if (isA) {
    answers.push([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 104, 21, 1, 1]);
  }
  head[6] = 0; head[7] = answers.length;
  return new Uint8Array([...head, ...out, ...answers.flat()]);
}

async function resolve(name, target, extraEnv = {}) {
  _resetMemo();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Response(fakeUpstream(init.body, target), { headers: { "content-type": "application/dns-message" } });
  try {
    const env = { ECH_PATH: "p", CACHE: "off", BEST_IPV4: POOL_IP, ...extraEnv };
    const res = await handle(new Request(`https://doh.example.com/p/resolve?name=${name}&type=A`), env, {});
    return (await res.json()).answers.map((a) => a.data);
  } finally {
    globalThis.fetch = realFetch;
  }
}

beforeEach(() => _resetMemo());

test("CNAME to pacloudflare.com is passed through, not rewritten", async () => {
  const got = await resolve("translate.example.com", "abc123.pacloudflare.com");
  assert.ok(got.includes(SPECTRUM_IP.join(".")), JSON.stringify(got));
  assert.ok(!got.includes(POOL_IP));
});

test("a normal Cloudflare A record is still rewritten", async () => {
  assert.deepEqual(await resolve("www.example.com", null), [POOL_IP]);
});

test("ECH_SKIP_CNAME=off disables the check", async () => {
  assert.deepEqual(await resolve("translate.example.com", "abc123.pacloudflare.com", { ECH_SKIP_CNAME: "off" }), [POOL_IP]);
});

test("skipByCname: suffix match on the name or any target, custom list", () => {
  assert.equal(skipByCname({}, "a.example.com", ["x.pacloudflare.com"]), true);
  assert.equal(skipByCname({}, "x.pacloudflare.com", []), true);
  assert.equal(skipByCname({}, "a.example.com", ["a.example.com.cdn.cloudflare.net"]), false);
  assert.equal(skipByCname({ ECH_SKIP_CNAME: "foo.net, bar.org" }, "a.example.com", ["z.bar.org"]), true);
  assert.equal(skipByCname({ ECH_SKIP_CNAME: "foo.net" }, "a.example.com", ["x.pacloudflare.com"]), false);
});
