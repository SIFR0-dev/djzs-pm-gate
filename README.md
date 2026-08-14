# djzs-polymarket-gate

Gate Polymarket CLOB trades with [djzs.ai](https://djzs.ai)'s `verify_pm_trade`
reasoning audit. Every order is audited **before** it is created — if the
prediction-market thesis is unfalsifiable, unsourced, or under-specified, the
trade is halted and no money moves.

```
capital action
 │
 ▼
GATE 1 · djzs.ai audits the THESIS (why)  →  PASS / WAIT / FAIL
 ├─ WAIT / FAIL / out-of-scope  ─▶  HALT · no order created
 │
 EXECUTE
 │
 ▼
GATE 2 · Polymarket CLOB creates + posts the order (what)
 ▼
on-chain
```

djzs.ai audits **why** a trade should be made (the thesis). The wallet layer
audits **what** moves (transaction safety). This package wires the first gate
in front of the official [`@polymarket/clob-client`](https://www.npmjs.com/package/@polymarket/clob-client).

## How it works

- djzs.ai is an MCP tool (`verify_pm_trade`) at `https://mcp.djzs.ai/mcp`,
  served over **streamable HTTP** and paid via **x402** (2.00 USDC on Base
  mainnet).
- This package wraps a standard MCP `Client` with **`withX402Client` from
  [`agents/x402`](https://www.npmjs.com/package/agents)** — the client djzs.ai's
  [llms.txt](https://djzs.ai/llms.txt) prescribes, and the counterpart to the
  `withX402` wrapper the server applies to its `/mcp` route. It signs an
  EIP-3009 USDC transfer on Base when the server returns HTTP 402.
- **The client choice is not cosmetic.** Other x402 client libraries complete
  the 402 handshake against this server but never settle: the call comes back
  with the payment challenge instead of a verdict, the audit never runs, and
  the payer's balance is unchanged. Use `agents/x402` — matching the server's
  wrapper is what makes settlement happen.
- The thesis travels as the **`intent`** argument (the tool's real parameter
  name, confirmed against the live schema), alongside optional
  `target_system` and `agent_address`.
- `GatedClobClient.placeGatedOrder(thesis, order)` audits the thesis, then —
  only on `PASS` — calls `ClobClient.createAndPostOrder`.

## Install

```bash
npm install
```

## Configure

```bash
cp .env.example .env
# then fill in EVM_PRIVATE_KEY (Base, funds the 2.00 USDC audit),
# POLYMARKET_PRIVATE_KEY + POLYMARKET_FUNDER, and EXAMPLE_TOKEN_ID + EXAMPLE_THESIS
```

## Run

```bash
npm run example
```

## Programmatic usage

```ts
import { Side } from "@polymarket/clob-client";
import { DjzsGate, GatedClobClient, TradeHaltedError } from "djzs-polymarket-gate";

const gate = new DjzsGate({
  payerPrivateKey: process.env.EVM_PRIVATE_KEY as `0x${string}`,
  agentAddress: "0xYourAgentWallet", // optional: writes to the on-chain trust loop
});

const trader = new GatedClobClient(gate, {
  privateKey: process.env.POLYMARKET_PRIVATE_KEY as `0x${string}`,
  funder: "0xYourPolymarketProfileAddress",
  signatureType: 1, // 0 browser, 1 magic/email
});

try {
  const { order, audit } = await trader.placeGatedOrder(
    {
      tokenID: "…",
      price: 0.55,
      side: Side.BUY,
      size: 10,
      thesis:
        "Market X resolves YES. My claim is falsified if event Y occurs by " +
        "date Z. Sourced probability 0.62 per [source]; market prices 0.55, " +
        "so my edge is +7pts.",
    },
    { tickSize: "0.001", negRisk: false },
  );
  console.log("executed", order, "audit", audit.verdict_hash);
} catch (err) {
  if (err instanceof TradeHaltedError) {
    console.error("blocked:", err.result.verdict, err.result.flags);
    console.error("clarify:", err.result.unknown_fields);
  } else throw err;
}
```

## The `maxPaymentValue` gotcha

`withX402Client`'s default payment cap is **0.10 USDC**, which **refuses**
djzs.ai's **2.00 USDC** audit price — the call fails before the audit runs.

This package fixes that by passing `maxPaymentValue` explicitly, from
`maxPaymentAtomic` (default `2_000_000n` = 2.00 USDC). The same cap is
re-checked in the confirmation callback — the first argument to `callTool` —
before anything is signed: at or below the cap is approved, above it is
refused. If you raise djzs.ai's price, raise `DJZS_MAX_PAYMENT_USDC` to match.

## The thesis is the audited input

`verify_pm_trade` audits a **free-text prediction-market thesis**, not the
order parameters. A well-formed thesis states:

1. the claim and its outcome,
2. the **sourced** probability (with a citation),
3. the **falsification** condition (what would prove it wrong),
4. the edge vs. the market price.

A consensus-only thesis with no source returns `FAIL` (`DJZS-M03
PROBABILITY_UNSOURCED`), and the order is never created. That is the intended
behavior — abstention is a first-class outcome.

## Registry tools (free)

djzs.ai also exposes two free read tools you can call through the same MCP
session: `query_pol_certificates` (ProofOfLogic certificates on Irys) and
`query_agent_trust` (an agent's on-chain trust score: `totalAudits`,
`failRate`, latest verdict, `PROCEED`/`HALT`/`NO_HISTORY`). Use the public
helpers on the gate:

```ts
await gate.listTools();              // confirm the verify_pm_trade input schema
const trust = await gate.callTool("query_agent_trust", { agent_address: "0x…" });
```

`gate.listTools()` goes through the **unwrapped** client, so it is free and
never enters the payment path. Its `inputSchema` confirms the
`verify_pm_trade` arguments — `intent`, `target_system`, `agent_address` —
which are this package's defaults (`thesisArg: "intent"`,
`agentAddressArg: "agent_address"`). Override them via
`DjzsGateConfig.thesisArg` / `agentAddressArg` if the schema changes.

## Wiring into the Python Polymarket/agents repo

This package is a TypeScript CLOB reference integration (it matches djzs.ai's
documented TypeScript / `agents/x402` integration path). To gate the official Python
[`Polymarket/agents`](https://github.com/Polymarket/agents) framework, insert
the same gate at the seam between thesis-formation and order placement in
`agents/application/trade.py`: build the thesis string, call `verify_pm_trade`
over the MCP endpoint against `https://mcp.djzs.ai/mcp`, and only proceed to
the CLOB order placement on `PASS`. The thesis-to-order seam is identical to
the one `GatedClobClient.placeGatedOrder` implements here.

**Caveat: the Python path is untested against this server.** Only the seam is
known to transfer; the payment client is not. Nothing here establishes that
the Python `x402` SDK — or any other Python x402 client — actually settles
against djzs.ai's `withX402`-wrapped route.

Take that seriously, because **the TypeScript client mismatch documented above
failed silently.** The handshake completed, the client reported
`paymentMade: true`, and no error was raised — but the response body was the
payment challenge, the audit never ran, and nothing was paid. A gate that
returns a fabricated verdict is worse than no gate. Verify any Python client
the same two ways before trusting it:

1. **Confirm the response is an engine verdict, not a payment challenge.**
   Reject any body carrying `x402Version` or `error: "PAYMENT_REQUIRED"` —
   this package throws on exactly that (see `parseResult` in `src/gate.ts`);
   without the check, an unsettled challenge normalizes into a false `WAIT`.
2. **Check the payer's USDC balance on Base.** A real audit moves 2.00 USDC.
   If the balance is unchanged, the audit did not run, whatever the client
   reported.

## Status

**Verified.** Typecheck passes from a clean install (`npm ci && npm run
typecheck`). Verified live against `https://mcp.djzs.ai/mcp` that the
`verify_pm_trade` schema is `intent` / `target_system` / `agent_address`, and
that an out-of-scope intent returns `in_scope: false`, `verdict: null` and
settles **nothing** — confirmed on-chain, the payer's USDC balance is
unchanged.

**Not yet exercised: the paid path.** A settling 2.00 USDC audit has not been
run. That requires a funded Base wallet with >= 2.00 USDC; a full end-to-end
run also needs a valid Polymarket trading wallet. Run `npm run example` with
real credentials to exercise x402 payment + audit + order placement.

### Dependency pinning

`@modelcontextprotocol/sdk` is pinned to **exactly 1.29.0** and `agents` to
**0.17.3**. `agents` depends on that exact SDK version; a caret range installs
a second copy of the SDK, and the duplicate `Client` class produces a
**TS2344** type conflict on its private properties. Do not loosen either pin.

## Sources

- [djzs.ai](https://djzs.ai) — product, MCP endpoint, x402 pricing, architecture
- [djzs.ai/llms.txt](https://djzs.ai/llms.txt) — machine-readable integration contract
- [djzs-AI repo (GitHub)](https://github.com/SIFR0-dev/djzs-AI) — tool list, response contract
- [`agents/x402`](https://www.npmjs.com/package/agents) — `withX402Client`, the client counterpart to the server's `withX402` wrapper
- [@polymarket/clob-client (npm)](https://www.npmjs.com/package/@polymarket/clob-client) — `createAndPostOrder`
- [Model Context Protocol TS SDK](https://github.com/modelcontextprotocol/typescript-sdk) — `StreamableHTTPClientTransport`
