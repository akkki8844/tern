import { httpGet } from "./http.js";

export async function getInvoice(id: string) {
  return httpGet(`/invoices/${id}`);
}
