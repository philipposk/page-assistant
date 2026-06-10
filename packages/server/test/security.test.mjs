import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimit, bearerAuth } from "../dist/ratelimit.js";

function fakeReqRes(ip = "1.2.3.4", headers = {}) {
  let statusCode = 200;
  let jsonBody;
  const res = {
    setHeader() {},
    status(c) {
      statusCode = c;
      return res;
    },
    json(b) {
      jsonBody = b;
      return res;
    },
  };
  return { req: { ip, headers }, res, get status() { return statusCode; }, get body() { return jsonBody; } };
}

test("rate limiter blocks after max and allows under it", () => {
  const mw = rateLimit({ windowMs: 60_000, max: 3 });
  let passed = 0;
  for (let i = 0; i < 5; i++) {
    const ctx = fakeReqRes();
    mw(ctx.req, ctx.res, () => passed++);
    if (i >= 3) assert.equal(ctx.status, 429);
  }
  assert.equal(passed, 3);
});

test("rate limiter isolates by IP", () => {
  const mw = rateLimit({ windowMs: 60_000, max: 1 });
  let passed = 0;
  for (const ip of ["a", "b", "c"]) {
    const ctx = fakeReqRes(ip);
    mw(ctx.req, ctx.res, () => passed++);
  }
  assert.equal(passed, 3);
});

test("bearerAuth open when no token configured", () => {
  const mw = bearerAuth(undefined);
  let passed = 0;
  const ctx = fakeReqRes();
  mw(ctx.req, ctx.res, () => passed++);
  assert.equal(passed, 1);
});

test("bearerAuth rejects wrong token, accepts right one", () => {
  const mw = bearerAuth("secret");
  const bad = fakeReqRes("x", { authorization: "Bearer wrong" });
  let passed = 0;
  mw(bad.req, bad.res, () => passed++);
  assert.equal(bad.status, 401);
  const good = fakeReqRes("x", { authorization: "Bearer secret" });
  mw(good.req, good.res, () => passed++);
  assert.equal(passed, 1);
});
