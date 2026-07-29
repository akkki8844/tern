
import express from "express";
import { createCharge, retrieveCharge } from "./acmepay-client.js";

const app = express();
app.use(express.json());

app.post("/charges", async (req, res) => {
  try {
    const charge = await createCharge({
      amount: req.body.amount,
      currency: req.body.currency,
      source: req.body.source,
      description: req.body.description
    });
    res.json(charge);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/charges/:id", async (req, res) => {
  try {
    const charge = await retrieveCharge(req.params.id);
    res.json(charge);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default app;
if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen(3000, () => console.log("Demo app on :3000"));
}
