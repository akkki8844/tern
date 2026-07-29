
import { processPayment, getChargeStatus } from "./client";

async function main() {
  const status = await processPayment(1000, "tok_visa", "usd");
  console.log("Payment status:", status);
  const lookup = await getChargeStatus("ch_123");
  console.log("Lookup status:", lookup);
}

main().catch(console.error);
