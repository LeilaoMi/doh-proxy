// Unit tests for STEALTH mode. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, isStealth } from "../src/doh.js";

const BASE = "https://doh.example.com";
const get = (path, env) => handle(new Request(BASE + path), env, {});

test("isStealth parses common truthy values", () => {
  for (const v of ["1", "true", "TRUE", " yes ", "on"]) assert.equal(isStealth({ STEALTH: v }), true);
  for (const v of [undefined, "", "0", "false", "off"]) assert.equal(isStealth({ STEALTH: v }), false);
});

test("stealth hides /, /health and /dns-query", async () => {
  const env = { STEALTH: "1", ECH_PATH: "secretpath" };
  for (const p of ["/", "/health", "/dns-query"]) assert.equal((await get(p, env)).status, 404, p);
});

test("stealth keeps <ECH_PATH>/health", async () => {
  const r = await get("/secretpath/health", { STEALTH: "1", ECH_PATH: "secretpath" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: "ok" });
});

test("stealth is ignored without ECH_PATH (no lock-out)", async () => {
  const env = { STEALTH: "1" };
  assert.equal((await get("/", env)).status, 200);
  assert.equal((await get("/health", env)).status, 200);
});

test("default (no STEALTH) keeps public endpoints", async () => {
  const env = { ECH_PATH: "secretpath" };
  assert.equal((await get("/", env)).status, 200);
  assert.equal((await get("/health", env)).status, 200);
});
