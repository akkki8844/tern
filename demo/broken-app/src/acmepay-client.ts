
const BASE_URL = "https://api.acmepay.example.com/v1";

export interface CreateChargeInput {
  amount: number;
  currency: string;
  source: string;
  description?: string;
}

export interface Charge {
  id: string;
  amount: number;
  currency: string;
  status: string;
  description?: string;
}

export async function createCharge(input: CreateChargeInput): Promise<Charge> {
  const res = await fetch(`${BASE_URL}/charges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: input.amount,
      currency: input.currency,
      source: input.source,
      description: input.description
    })
  });
  if (!res.ok) throw new Error(`createCharge failed: ${res.status}`);
  return res.json() as Promise<Charge>;
}

export async function retrieveCharge(id: string): Promise<Charge> {
  const res = await fetch(`${BASE_URL}/charges/${id}`);
  if (!res.ok) throw new Error(`retrieveCharge failed: ${res.status}`);
  return res.json() as Promise<Charge>;
}
