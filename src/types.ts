/**
 * Type contracts for the djzs.ai `verify_pm_trade` audit and the gate config.
 *
 * The response contract follows djzs.ai's published llms.txt / homepage:
 * verdict, action, risk_score, flags, unknown_fields, disagreements,
 * verdict_hash, plus advisory fields (in_scope, extraction_failsafe).
 */

export type Verdict = "PASS" | "WAIT" | "FAIL";
export type AuditAction = "PROCEED" | "HALT";

/** Normalized result of a `verify_pm_trade` call. */
export interface VerifyPmTradeResult {
  /** PASS / WAIT / FAIL. */
  verdict: Verdict;
  /** PROCEED only on PASS; HALT on WAIT/FAIL. */
  action: AuditAction;
  /** 0-100 aggregate risk weight. */
  risk_score: number;
  /** Fired taxonomy codes, e.g. ["DJZS-M03", "DJZS-M04"]. */
  flags: string[];
  /** Fields the engine could not resolve — the caller must clarify these. */
  unknown_fields: string[];
  /** Per-field N=3 sample-agreement telemetry. */
  disagreements: string[];
  /** Reproducible sha256 of the canonicalized verdict. */
  verdict_hash: string;
  /** false when the thesis did not extract as a prediction-market thesis. */
  in_scope?: boolean;
  /** True when extraction fell back to a failsafe path. */
  extraction_failsafe?: boolean;
  /** Raw text returned by the MCP tool, for debugging. */
  raw?: string;
  [k: string]: unknown;
}

export interface DjzsGateConfig {
  /**
   * Base-mainnet EOA private key that pays the 2.00 USDC audit fee over x402.
   * Fund it with >= 2 USDC (Base). Gas is paid by the x402 facilitator
   * (EIP-3009 signature), so this wallet does not need ETH for the audit.
   */
  payerPrivateKey: `0x${string}`;
  /**
   * Optional agent wallet address. When set, djzs.ai writes the verdict to the
   * on-chain DJZS trust record (DJZSLogicTrustScore on Base), readable via
   * `query_agent_trust`.
   */
  agentAddress?: `0x${string}`;
  /** MCP streamable-HTTP endpoint. Default: https://mcp.djzs.ai/mcp */
  endpoint?: string;
  /** Argument name carrying the free-text thesis. Default: "intent". */
  thesisArg?: string;
  /** Argument name carrying the agent address. Default: "agent_address". */
  agentAddressArg?: string;
  /**
   * Hard cap on the audit fee the client will auto-approve, in USDC atomic
   * units (6 decimals). Default 2_000_000n = 2.00 USDC, matching djzs.ai's
   * published price. Anything above this is refused — this is the
   * `maxPaymentValue` gotcha: the x402 client default is 0.10 USDC, which
   * would refuse djzs.ai's 2.00 USDC fee.
   */
  maxPaymentAtomic?: bigint;
}

/**
 * Thrown when `verify_pm_trade` returns WAIT or FAIL (or out-of-scope),
 * before any Polymarket order is created. Carries the full audit result so
 * the caller can log the verdict_hash and surface `unknown_fields`.
 */
export class TradeHaltedError extends Error {
  constructor(public readonly result: VerifyPmTradeResult) {
    super(
      `Trade halted by DJZS: verdict=${result.verdict} action=${result.action} ` +
        `risk=${result.risk_score} flags=[${result.flags.join(",") || "none"}] ` +
        `unknown_fields=[${result.unknown_fields.join(",") || "none"}] ` +
        `hash=${result.verdict_hash}`,
    );
    this.name = "TradeHaltedError";
  }
}
