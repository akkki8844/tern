import express from "express";
import { submitPayment } from "./paymentService";

const app = express();
app.use(express.json());

app.post("/payments/:chargeId", async (req, res) => {
  const chargeId = req.params.chargeId;
  const amount = Number(req.body.amount ?? 0);
  const result = await submitPayment(chargeId, amount);
  res.json(result);
});

export default app;
