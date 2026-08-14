import "dotenv/config";
import { Side, type TickSize } from "@polymarket/clob-client";
import { DjzsGate, GatedClobClient, TradeHaltedError } from "../src/index.js";

/**
 * End-to-end demo:
 *   1. Connect the djzs.ai gate (x402 payer on Base mainnet).
 *   2. Audit a prediction-market thesis with `verify_pm_trade`.
 *   3. Only on PASS, create + post a Polymarket CLOB order.
 *
 * Set the env vars in .env (copied from .env.example) before running:
 *   npm run example
 *
 * The thesis is the part djzs.ai audits. Edit EXAMPLE_THESIS to describe the
 * claim, its sourced probability, and its falsification condition. A vague
 * "consensus" thesis with no source will return FAIL (DJZS-M03/M04), which is
 * the whole point — the trade is blocked before money moves.
 */
async function main() {
  const payerPrivateKey = required("EVM_PRIVATE_KEY") as `0x${string}`;
  const polymarketPrivateKey = required("POLYMARKET_PRIVATE_KEY") as `0x${string}`;
  const funder = required("POLYMARKET_FUNDER") as `0x${string}`;
  const tokenId = required("EXAMPLE_TOKEN_ID");
  const thesis = process.env.EXAMPLE_THESIS ?? "";
  if (!thesis) {
    console.error("Set EXAMPLE_THESIS to the prediction-market trade thesis.");
    process.exit(1);
  }

  const gate = new DjzsGate({
    payerPrivateKey,
    agentAddress: (process.env.DJZS_AGENT_ADDRESS as `0x${string}`) || undefined,
    endpoint: process.env.DJZS_MCP_ENDPOINT,
    maxPaymentAtomic: usdcAtomic(Number(process.env.DJZS_MAX_PAYMENT_USDC ?? 2.0)),
  });

  const trader = new GatedClobClient(gate, {
    privateKey: polymarketPrivateKey,
    funder,
    signatureType: Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? 1) as 0 | 1,
  });

  try {
    console.log("Auditing thesis with djzs.ai…");
    const result = await trader.placeGatedOrder(
      {
        tokenID: tokenId,
        price: Number(process.env.EXAMPLE_PRICE ?? 0.01),
        side: Side.BUY,
        size: Number(process.env.EXAMPLE_SIZE ?? 5),
        thesis,
      },
      {
        tickSize: (process.env.EXAMPLE_TICK_SIZE ?? "0.001") as TickSize,
        negRisk: String(process.env.EXAMPLE_NEG_RISK ?? "false") === "true",
      },
    );
    console.log("✅ Trade executed (audit PASS).");
    console.log("   verdict_hash:", result.audit.verdict_hash);
    console.log("   order:", result.order);
  } catch (err) {
    if (err instanceof TradeHaltedError) {
      console.error("🛑 Trade halted by djzs.ai:");
      console.error("  ", err.message);
      if (err.result.unknown_fields.length) {
        console.error("   Clarify these unknown fields:", err.result.unknown_fields.join(", "));
      }
      process.exit(2);
    }
    throw err;
  } finally {
    await gate.close();
  }
}

function required(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing env var: ${key} (see .env.example)`);
    process.exit(1);
  }
  return v;
}

function usdcAtomic(usdc: number): bigint {
  return BigInt(Math.round(usdc * 1e6));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
