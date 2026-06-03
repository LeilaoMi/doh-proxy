#!/usr/bin/env node

const endpoint = (process.argv[2] || "https://doh.leilaomi.ccwu.cc/dns-query").replace(/\/+$/, "");
const domain = process.argv[3] || "example.com";

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createDnsQuery(name) {
  const id = crypto.getRandomValues(new Uint8Array(2));
  const labels = [];
  for (const part of name.split(".")) labels.push(part.length, ...Buffer.from(part));
  const query = Buffer.from([
    ...id, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, ...labels, 0x00, 0x00, 0x01, 0x00, 0x01,
  ]);
  return { id: Buffer.from(id), query };
}

function parseDnsSummary(buffer, id) {
  if (buffer.length < 12) return { valid: false, reason: "DNS response too short" };
  return {
    valid: buffer.subarray(0, 2).equals(id) && (buffer[3] & 0x0f) === 0,
    rcode: buffer[3] & 0x0f,
    answers: buffer.readUInt16BE(6),
  };
}

async function timed(name, fn) {
  const started = performance.now();
  try {
    const result = await fn();
    return { name, ok: true, ms: performance.now() - started, ...result };
  } catch (error) {
    return { name, ok: false, ms: performance.now() - started, error: error.message };
  }
}

async function main() {
  const { id, query } = createDnsQuery(domain);
  const dns = base64url(query);
  const tests = [
    timed("health", async () => {
      const response = await fetch(endpoint);
      return { status: response.status, type: response.headers.get("content-type") };
    }),
    timed("OPTIONS", async () => {
      const response = await fetch(endpoint, { method: "OPTIONS" });
      return { status: response.status, type: response.headers.get("content-type") };
    }),
    timed("RFC8484 GET", async () => {
      const response = await fetch(`${endpoint}?dns=${dns}`, { headers: { accept: "application/dns-message" } });
      const body = Buffer.from(await response.arrayBuffer());
      return { status: response.status, type: response.headers.get("content-type"), ...parseDnsSummary(body, id) };
    }),
    timed("RFC8484 POST", async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { accept: "application/dns-message", "content-type": "application/dns-message" },
        body: query,
      });
      const body = Buffer.from(await response.arrayBuffer());
      return { status: response.status, type: response.headers.get("content-type"), ...parseDnsSummary(body, id) };
    }),
  ];

  console.log(`Endpoint: ${endpoint}`);
  console.log(`Domain:   ${domain}`);
  console.log("----------------------------------------");

  const results = await Promise.all(tests);
  for (const result of results) {
    const ok = result.ok && result.status >= 200 && result.status < 300 && (result.valid ?? true);
    const detail = result.error || `status=${result.status} type=${result.type || ""} answers=${result.answers ?? "-"} rcode=${result.rcode ?? "-"}`;
    console.log(`${ok ? "✅" : "❌"} ${result.name.padEnd(12)} ${result.ms.toFixed(1).padStart(7)}ms  ${detail}`);
  }

  if (results.some((result) => !result.ok || result.status < 200 || result.status >= 300 || result.valid === false)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
