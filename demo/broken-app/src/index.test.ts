
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { createCharge, retrieveCharge } from "./acmepay-client.js";

interface CapturedRequest { url: string; method: string; body: unknown; }

describe("acmepay client v2 compliance", () => {
  let captured: CapturedRequest[] = [];
  let fetchResponses: Array<{ url: string; body: Record<string, unknown> }> = [];

  beforeEach(() => {
    captured = [];
    fetchResponses = [];
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      captured.push({ url, method: init?.method || "GET", body });
      const mockBody = body ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "pay_123",
          amount: mockBody.amount ?? 100,
          currency: mockBody.currency ?? "usd",
          state: "succeeded",
          memo: mockBody.memo ?? ""
        })
      } as Response;
    };
  });

  it("createCharge sends payment_method and customer_id", async () => {
    await createCharge({ amount: 100, currency: "usd", source: "tok_visa", description: "Test" });
    const req = captured.find(r => r.method === "POST" && r.url.includes("/charges"));
    assert.ok(req, "POST request found");
    assert.ok(req.body);
    assert.strictEqual((req.body as any).payment_method, "tok_visa");
    assert.strictEqual((req.body as any).customer_id, "cust_demo");
  });

  it("retrieveCharge uses chargeId path parameter", async () => {
    await retrieveCharge("pay_123");
    const req = captured.find(r => r.method === "GET");
    assert.ok(req, "GET request found");
    assert.ok(req.url.includes("/charges/pay_123"));
  });

  it("createCharge response contains state", async () => {
    const charge = await createCharge({ amount: 100, currency: "usd", source: "tok_visa" });
    assert.strictEqual(charge.state, "succeeded");
  });

  it("retrieveCharge response contains state", async () => {
    const charge = await retrieveCharge("pay_123");
    assert.strictEqual(charge.state, "succeeded");
  });
});
