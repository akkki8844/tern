import { getInvoice } from "./invoices.js";

export async function renderInvoice(id: string) {
  return displayInvoice(id);
}

export async function displayInvoice(id: string) {
  return getInvoice(id);
}
