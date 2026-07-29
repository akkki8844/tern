
import { describe, it } from "node:test";
import assert from "node:assert";
import { processPayment, getChargeStatus } from "./client";

describe("AcmePay client v1", () => {
  it("processPayment returns status", async () => {
    const status = await processPayment(1000, "tok_visa", "usd");
    assert.ok(typeof status === "string");
  });

  it("getChargeStatus returns status", async () => {
    const status = await getChargeStatus("ch_123");
    assert.ok(typeof status === "string");
  });
});
