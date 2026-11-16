import axios from "axios";

export const api = axios.create({ baseURL: "https://api.example.com" });

export async function listOrders() {
  const res = await api.get("/orders");
  return res.data;
}

export async function cancelOrder(id: string) {
  const res = await api.delete(`/orders/${id}`);
  return res.data;
}
