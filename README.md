# djzs-pm-gate

Gate prediction-market orders with [djzs.ai](https://djzs.ai)'s `verify_pm_trade`
reasoning audit. Every order is audited **before** it is created — if the
thesis is unfalsifiable, unsourced, or under-specified, the trade is halted and
no money moves.

Two venues ship today, behind one venue-agnostic gate:

| Venue | Adapter | Client | Source |
| --- | --- | --- | --- |
| Polymarket (CLOB) | `GatedClobClient` | `@polymarket/clob-client` | [`src/polymarket.ts`](src/polymarket.ts) |
| Kalshi (event markets) | `GatedKalshiClient` | `kalshi-typescript` | [`src/kalshi.ts`](src/kalshi.ts) |

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
GATE 2 · the venue creates + posts the order (what)
 ▼
Polymarket CLOB  ·  Kalshi event markets
```

djzs.ai audits **why** a trade should be made (the thesis). The venue layer
audits **what** moves (order validity, margin, transaction safety). This
package wires the first gate in front of the second. GATE 1 is identical for
every venue — the audit knows nothing about tick sizes, tickers, or signature
types, only about the thesis.

---

# The gate (shared)

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
- Each venue adapter calls `gate.verifyTrade(thesis)`, halts on anything that
  is not a clean in-scope `PASS`, and only then places the order.

## Install

```bash
npm install
```

## Configure

```bash
cp .env.example .env
# then fill in EVM_PRIVATE_KEY (Base, funds the 2.00 USDC audit),
# plus the credentials for whichever venue you are trading (see below)
```

`EVM_PRIVATE_KEY` funds the audit and is required for both venues. Venue
credentials are separate and independent — the Base payer wallet never touches
the venue, and the venue credentials never touch the audit.

## Constructing the gate

```ts
import { DjzsGate } from "djzs-pm-gate";

const gate = new DjzsGate({
  payerPrivateKey: process.env.EVM_PRIVATE_KEY as `0x${string}`,
  agentAddress: "0xYourAgentWallet", // optional: writes to the on-chain trust loop
});
```

One `DjzsGate` can back any number of venue adapters — it holds the MCP
session and the payer, nothing venue-specific.

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

This is venue-independent: the same thesis produces the same verdict and the
same `verdict_hash` whether it is destined for Polymarket or Kalshi.

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

---

# Venues

## Polymarket (CLOB)

Wraps the official
[`@polymarket/clob-client`](https://www.npmjs.com/package/@polymarket/clob-client).
`GatedClobClient.placeGatedOrder(params, options)` audits the thesis, then —
only on `PASS` — calls `ClobClient.createAndPostOrder`.

```bash
# .env
POLYMARKET_PRIVATE_KEY=0x...   # the wallet that places the order
POLYMARKET_FUNDER=0x...        # your Polymarket profile address (where USDC lives)
POLYMARKET_SIGNATURE_TYPE=1    # 0 browser wallet, 1 Magic/email login
```

```ts
import { Side } from "@polymarket/clob-client";
import { DjzsGate, GatedClobClient, TradeHaltedError } from "djzs-pm-gate";

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

The bundled example script (`npm run example`) covers **Polymarket only**.

## Kalshi (event markets)

Wraps the official
[`kalshi-typescript`](https://www.npmjs.com/package/kalshi-typescript) SDK.
`GatedKalshiClient.placeGatedOrder(params)` audits the thesis, then — only on
`PASS` — calls `OrdersApi.createOrderV2`.

**Defaults to the DEMO host.** `KALSHI_DEMO`
(`https://demo-api.kalshi.co/trade-api/v2`) is the default on purpose: Kalshi's
demo exchange takes real orders against fake money, so the whole gated path
(audit → PASS → order placed) can be proven without risking trade capital.
Point at `KALSHI_PRODUCTION` explicitly, and only when you mean it.

**Scope: event-market orders only.** This gates Kalshi's event-market order
entry (`/orders`, the V2 endpoint). It **deliberately does not wrap Kalshi's
separate perpetual-futures (margin) order API.** `verify_pm_trade` is a
prediction-market tool: it answers a perp thesis with `in_scope: false` —
correctly, and for free, but that means a perps order routed through this gate
would never actually be audited. A gate that cannot audit what passes through
it is worse than no gate, so that API is left unwrapped. Perp auditing ships
separately.

Auth is an API key ID plus an RSA private key — Kalshi signs every
authenticated request with RSA-PSS, and the SDK does the signing. Supply the
key inline as `privateKeyPem` or from disk as `privateKeyPath`; the constructor
throws if neither is given.

```ts
import { BookSide } from "kalshi-typescript";
import { DjzsGate, GatedKalshiClient, KALSHI_PRODUCTION, TradeHaltedError } from "djzs-pm-gate";

const trader = new GatedKalshiClient(gate, {
  apiKey: process.env.KALSHI_API_KEY!,
  privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH!,
  // basePath defaults to KALSHI_DEMO; pass KALSHI_PRODUCTION deliberately.
});

try {
  const { order, audit } = await trader.placeGatedOrder({
    ticker: "KXFEDDECISION-26SEP-H0",
    side: BookSide.Bid, // bid buys YES; ask sells YES (= buying NO at 1 - price)
    count: "10",
    price: "0.64",
    thesis:
      "The Sep FOMC holds. Falsified by a cut at the Sep meeting. Sourced " +
      "probability 0.71 per [source]; market prices 0.64, edge +7pts.",
  });
  console.log("executed", order, "audit", audit.verdict_hash);
} catch (err) {
  if (err instanceof TradeHaltedError) {
    console.error("blocked:", err.result.verdict, err.result.flags);
  } else throw err;
}
```

`auditOnly(thesis)` runs the audit without trading and never throws on
WAIT/FAIL — the right call for dry runs. `getOrdersApi()` exposes the
underlying SDK client for cancels and lookups, which are not gated (they move
no new capital).

Note that no Kalshi client is constructed and no order payload is built until
the audit returns `PASS`.

---

## Wiring into the Python Polymarket/agents repo

This package is a TypeScript reference integration (it matches djzs.ai's
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
run, on either venue. That requires a funded Base wallet with >= 2.00 USDC; a
full end-to-end run also needs venue credentials (a Polymarket trading wallet,
or a Kalshi API key + RSA key). Run `npm run example` with real credentials to
exercise x402 payment + audit + order placement on Polymarket.

**Neither venue adapter has placed a live order.** The Kalshi path has not been
run against the demo exchange either, which is the cheapest way to prove it —
demo orders cost nothing but still exercise auth, signing, and order entry.

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
- [kalshi-typescript (npm)](https://www.npmjs.com/package/kalshi-typescript) — `OrdersApi.createOrderV2`, RSA-PSS request signing
- [Model Context Protocol TS SDK](https://github.com/modelcontextprotocol/typescript-sdk) — `StreamableHTTPClientTransport`
