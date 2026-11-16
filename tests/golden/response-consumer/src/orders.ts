import { api } from "./api.js";

export async function orderTotal(id: string): Promise<number> {
  const res = await api.get(`/orders/${id}`);
  // Consumes the response property `total` that v2 renames.
  return res.data.total;
}
