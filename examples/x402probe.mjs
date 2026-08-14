import "dotenv/config";
import { DjzsGate } from "../src/index.js";

const gate = new DjzsGate({
  payerPrivateKey: process.env.EVM_PRIVATE_KEY,
  maxPaymentAtomic: 2_000_000n,
});

try {
  console.log("calling verify_pm_trade directly, dumping FULL response");
  const res = await gate.callTool("verify_pm_trade", {
    intent: "Reorganize the kitchen pantry by expiration date.",
  });
  console.log("paymentMade :", res?.paymentMade);
  console.log("isError     :", res?.isError);
  console.log("top-level keys:", Object.keys(res ?? {}).join(", "));
  console.log("FULL:", JSON.stringify(res, null, 2).slice(0, 1500));
} catch (e) {
  console.log("THREW:", e?.message ?? String(e));
} finally {
  await gate.close();
}
