
import axios from "axios";
import { AcmePayConfig } from "./config";

const api = axios.create({
  baseURL: AcmePayConfig.baseUrl,
  headers: { Authorization: `Bearer ${AcmePayConfig.apiKey}` }
});

export async function createCharge(params: { amount: number; source: string; currency: string }) {
  const { data } = await api.post("/charges", params);
  return data as { id: string; status: string; amount: number };
}

export async function retrieveCharge(chargeId: string) {
  const { data } = await api.get(`/charges/${chargeId}`);
  return data as { id: string; status: string; amount: number };
}
