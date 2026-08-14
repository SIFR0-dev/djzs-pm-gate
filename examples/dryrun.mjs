import "dotenv/config";
import { DjzsGate } from "../src/index.js";

// FREE BY DESIGN: a non-prediction-market intent returns in_scope:false,
// which the server surfaces as isError -> the x402 middleware skips
// settlement. Full path exercised (connect, tool call, `intent` wire arg,
// live engine) with zero USDC moved.
const OUT_OF_SCOPE = "Reorganize the kitchen pantry by expiration date.";

const gate = new DjzsGate({
  payerPrivateKey: process.env.EVM_PRIVATE_KEY,
  maxPaymentAtomic: 2_000_000n,
});

try {
  console.log("1) listTools - confirming the live input schema");
  const tools = await gate.listTools();
  const v = tools.tools?.find((t) => t.name === "verify_pm_trade");
  console.log("   verify_pm_trade schema keys:",
    Object.keys(v?.inputSchema?.properties ?? {}));
  console.log("   >>> must include 'intent' (not 'thesis')");

  console.log("\n2) out-of-scope audit - expected FREE refusal");
  const r = await gate.verifyTrade(OUT_OF_SCOPE);
  console.log("   in_scope :", r.in_scope, "(false = refused, not charged)");
  console.log("   verdict  :", r.verdict, "| action:", r.action);
  console.log("   proceed? :", gate.shouldProceed(r), "(must be false)");

  console.log("\n3) RAW response (diagnosing in_scope undefined)");
  console.log("   keys:", Object.keys(r).join(", "));
  console.log("   raw :", (r.raw ?? "(no raw text)").slice(0, 500));
} finally {
  await gate.close();
}
