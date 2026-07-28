export async function createAcmeCharge(chargeId: string, amount: number) {
  const url = `/v1/charges/${chargeId}`;
  return { url, method: "POST", payload: { amount } };
}

export function normalizeChargeResponse(input: { id: string; statusText: string }) {
  return { id: input.id, statusText: input.statusText };
}
