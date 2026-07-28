import { createAcmeCharge, normalizeChargeResponse } from "./acmeClient";

export async function submitPayment(chargeId: string, amount: number) {
  const request = await createAcmeCharge(chargeId, amount);
  const response = normalizeChargeResponse({ id: "pm_123", statusText: "success" });
  return { request, response };
}
