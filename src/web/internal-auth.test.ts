import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyInternalIdentity } from "./internal-auth.js";

test("internal identity binds user, method, path, body and expiration", () => {
  const previous = process.env.WALRY_INTERNAL_SECRET;
  process.env.WALRY_INTERNAL_SECRET = "test-only-signing-key";
  try {
    const now = Date.now();
    const body = '{"enabled":false}';
    const path = "/api/v1/learning-memory";
    const signature = createHmac("sha256", process.env.WALRY_INTERNAL_SECRET).update([now, "user-a", "PATCH", path, body].join("\n")).digest("hex");
    const headers = new Headers({ "x-walry-user": "user-a", "x-walry-time": String(now), "x-walry-signature": signature });
    assert.equal(verifyInternalIdentity(headers, "PATCH", path, body, now), "user-a");
    assert.equal(verifyInternalIdentity(headers, "PATCH", path, '{}', now), undefined);
    assert.equal(verifyInternalIdentity(headers, "DELETE", path, body, now), undefined);
    assert.equal(verifyInternalIdentity(headers, "PATCH", `${path}?itemId=other`, body, now), undefined);
    assert.equal(verifyInternalIdentity(headers, "PATCH", path, body, now + 60001), undefined);
    headers.set("x-walry-user", "user-b");
    assert.equal(verifyInternalIdentity(headers, "PATCH", path, body, now), undefined);
  } finally {
    if (previous === undefined) delete process.env.WALRY_INTERNAL_SECRET;
    else process.env.WALRY_INTERNAL_SECRET = previous;
  }
});
