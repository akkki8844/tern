export function getDemoRepositoryFiles(): Record<string, string> {
  return {
    "src/acmeClient.ts": `export async function createAcmeCharge(chargeId: string, amount: number) {
  const url = \`/v1/charges/${"${chargeId}"}\`;
  const payload = {
    amount,
  };

  return {
    url,
    method: "POST",
    payload,
  };
}

export function normalizeChargeResponse(response: { id: string; statusText: string }) {
  return {
    id: response.id,
    statusText: response.statusText,
  };
}
`,
    "src/paymentService.ts": `import { createAcmeCharge, normalizeChargeResponse } from "./acmeClient";

export async function submitPayment(chargeId: string, amount: number) {
  const request = await createAcmeCharge(chargeId, amount);
  const mockResponse = { id: "pm_123", statusText: "succeeded" };
  return { request, normalized: normalizeChargeResponse(mockResponse) };
}
`,
  };
}
