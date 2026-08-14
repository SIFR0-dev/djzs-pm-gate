import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { withX402Client, type PaymentRequirements, type X402AugmentedClient } from "agents/x402";
import { privateKeyToAccount } from "viem/accounts";
import type { DjzsGateConfig, VerifyPmTradeResult, Verdict, AuditAction } from "./types.js";

/** Base mainnet CAIP-2 id. djzs.ai settles audits on Base (not Sepolia). */
const BASE_MAINNET = "eip155:8453";

/** The base MCP client augmented with x402 payment handling. */
type PaidClient = X402AugmentedClient & Client;

interface CallToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
  [k: string]: unknown;
}

/**
 * DjzsGate connects to djzs.ai's streamable-HTTP MCP endpoint and calls the
 * `verify_pm_trade` tool. Payment for the audit is handled over x402: the
 * server returns HTTP 402, the client signs an EIP-3009 transfer of 2.00 USDC
 * on Base, and the request is replayed with the payment proof.
 *
 * djzs.ai wraps its /mcp route server-side with `withX402` from `agents/x402`,
 * so the client MUST be the matching `withX402Client` from the same package.
 * Other x402 MCP clients complete the 402 handshake but never settle — the
 * call returns the payment challenge instead of a verdict and nothing is paid.
 *
 * The confirmation callback is the approval gate — it refuses any fee above
 * `maxPaymentAtomic` (default 2.00 USDC). That same value is passed as
 * `maxPaymentValue`, overriding the library default of 0.10 USDC, which would
 * otherwise refuse djzs.ai's 2.00 USDC audit price.
 */
export class DjzsGate {
  private readonly cfg: Required<Omit<DjzsGateConfig, "agentAddress">>;
  private readonly agentAddress?: `0x${string}`;
  /** Unwrapped client — used for free, unpaid calls such as listTools(). */
  private base: Client | null = null;
  /** x402-wrapped client — used for paid tool calls. */
  private paid: PaidClient | null = null;

  constructor(config: DjzsGateConfig) {
    this.agentAddress = config.agentAddress;
    this.cfg = {
      payerPrivateKey: config.payerPrivateKey,
      endpoint: config.endpoint ?? "https://mcp.djzs.ai/mcp",
      thesisArg: config.thesisArg ?? "intent",
      agentAddressArg: config.agentAddressArg ?? "agent_address",
      maxPaymentAtomic: config.maxPaymentAtomic ?? 2_000_000n,
    };
  }

  /** Connect (lazily, on first use) to the djzs.ai MCP server. */
  async connect(): Promise<void> {
    if (this.paid) return;

    const account = privateKeyToAccount(this.cfg.payerPrivateKey);

    const base = new Client({
      name: "djzs-pm-gate",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(new URL(this.cfg.endpoint));
    await base.connect(transport);

    this.base = base;
    this.paid = withX402Client(base, {
      account,
      network: BASE_MAINNET,
      // Without this the library caps auto-payment at 0.10 USDC and refuses
      // the 2.00 USDC audit.
      maxPaymentValue: this.cfg.maxPaymentAtomic,
    });
  }

  /**
   * Approval gate for the x402 payment. Called with the payment requirements
   * the server advertised; returning false aborts before anything is signed.
   */
  private readonly confirmPayment = async (accepts: PaymentRequirements[]): Promise<boolean> => {
    const req = accepts[0];
    if (!req) return false;
    const maxAtomic = this.cfg.maxPaymentAtomic;
    const amountAtomic = BigInt(req.amount);
    if (amountAtomic > maxAtomic) {
      console.error(
        `[djzs] refusing audit fee of ${req.amount} ${req.asset} ` +
          `(cap ${maxAtomic} atomic = ${Number(maxAtomic) / 1e6} USDC)`,
      );
      return false;
    }
    console.log(
      `[djzs] approving audit fee: ${req.amount} ${req.asset} on ${req.network}`,
    );
    return true;
  };

  /**
   * Audit a prediction-market trade thesis. Returns PASS/WAIT/FAIL plus flags,
   * unknown fields, and the reproducible verdict_hash. Does NOT place a trade.
   */
  async verifyTrade(thesis: string): Promise<VerifyPmTradeResult> {
    await this.connect();
    const args: Record<string, string> = { [this.cfg.thesisArg]: thesis };
    if (this.agentAddress) {
      args[this.cfg.agentAddressArg] = this.agentAddress;
    }

    // NOTE: agents/x402 puts the confirmation callback FIRST, ahead of the
    // usual { name, arguments } params object.
    const res = (await this.paid!.callTool(this.confirmPayment, {
      name: "verify_pm_trade",
      arguments: args,
    })) as CallToolResult;
    return parseResult(res);
  }

  /** True only on a clean in-scope PASS. WAIT, FAIL, and out-of-scope all halt. */
  shouldProceed(r: VerifyPmTradeResult): boolean {
    if (r.in_scope === false) return false;
    return r.verdict === "PASS";
  }

  /** List the tools exposed by the djzs.ai MCP server (e.g. to confirm the `verify_pm_trade` input schema). */
  async listTools() {
    await this.connect();
    // Listing is free — go through the unwrapped client so no payment path is
    // entered at all.
    return this.base!.listTools();
  }

  /** Call an arbitrary djzs.ai MCP tool by name (e.g. the free `query_agent_trust`). */
  async callTool(name: string, args: Record<string, unknown> = {}) {
    await this.connect();
    return this.paid!.callTool(this.confirmPayment, { name, arguments: args });
  }

  /** Disconnect from the MCP server. */
  async close(): Promise<void> {
    await this.base?.close();
    this.base = null;
    this.paid = null;
  }
}

function parseResult(res: CallToolResult): VerifyPmTradeResult {
  const text = res.content?.find((c) => c.type === "text")?.text;
  // djzs.ai returns the verdict as JSON text; some MCP servers also expose
  // structuredContent. Try text first, then structuredContent.
  const candidate = text ?? (typeof res.structuredContent === "string" ? res.structuredContent : undefined);
  let json: Record<string, unknown>;
  if (candidate) {
    try {
      json = JSON.parse(candidate);
    } catch {
      throw new Error(`djzs.ai returned non-JSON content: ${candidate}`);
    }
  } else if (res.structuredContent && typeof res.structuredContent === "object") {
    json = res.structuredContent as Record<string, unknown>;
  } else {
    throw new Error("djzs.ai returned no text or structured content");
  }

  // A payment challenge is NOT a verdict. If the handshake did not settle, the
  // body is the 402 payload — normalizing it would silently fabricate a
  // `verdict: WAIT` that no audit ever produced.
  if (json.error === "PAYMENT_REQUIRED" || json.x402Version !== undefined) {
    throw new Error(
      `djzs.ai returned an unsettled x402 payment challenge instead of a verdict: ${
        candidate ?? JSON.stringify(json)
      }`,
    );
  }

  const verdict = normalizeVerdict(json.verdict);
  return {
    verdict,
    action: normalizeAction(json.action, verdict),
    risk_score: Number(json.risk_score ?? 0),
    flags: toStringArray(json.flags),
    unknown_fields: toStringArray(json.unknown_fields),
    disagreements: toStringArray(json.disagreements),
    verdict_hash: String(json.verdict_hash ?? ""),
    in_scope: typeof json.in_scope === "boolean" ? json.in_scope : undefined,
    extraction_failsafe:
      typeof json.extraction_failsafe === "boolean" ? json.extraction_failsafe : undefined,
    raw: text,
  };
}

function normalizeVerdict(v: unknown): Verdict {
  const s = String(v ?? "").toUpperCase();
  if (s === "PASS" || s === "WAIT" || s === "FAIL") return s;
  // Unknown / undetermined => WAIT (the caller must halt and clarify).
  return "WAIT";
}

function normalizeAction(a: unknown, verdict: Verdict): AuditAction {
  const s = String(a ?? "").toUpperCase();
  if (s === "PROCEED" || s === "HALT") return s;
  return verdict === "PASS" ? "PROCEED" : "HALT";
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x));
}
