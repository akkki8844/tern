import { strict as assert } from "node:assert";
import test from "node:test";
import { createAcmeCharge, normalizeChargeResponse } from "../src/acmeClient";

test("uses migrated endpoint and required currency", async () => {
  const request = await createAcmeCharge("ch_123", 100);
  assert.equal(request.url.includes("/v2/payments"), true);
  assert.equal(Object.hasOwn(request.payload, "currency"), true);
});

test("uses renamed response field", () => {
  const normalized = normalizeChargeResponse({ id: "pm_123", statusText: "ok" } as never);
  assert.equal(Object.hasOwn(normalized, "state"), true);
});
