
import axios from "axios";
import { AcmePayConfig } from "./config";
import { createCharge, retrieveCharge } from "./api";

export async function processPayment(amount: number, source: string, currency: string = "usd") {
  const charge = await createCharge({ amount, source, currency });
  return charge.status;
}

export async function getChargeStatus(chargeId: string) {
  const charge = await retrieveCharge(chargeId);
  return charge.status;
}
