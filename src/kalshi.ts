import {
  BookSide,
  Configuration,
  CreateOrderV2RequestTimeInForceEnum,
  OrdersApi,
  SelfTradePreventionType,
  type CreateOrderV2Request,
  type CreateOrderV2Response,
} from "kalshi-typescript";
import type { DjzsGate } from "./gate.js";
import { TradeHaltedError, type VerifyPmTradeResult } from "./types.js";

/**
 * Kalshi API hosts.
 *
 * DEMO is the default on purpose. Kalshi's demo exchange takes real orders
 * against fake money, which makes it possible to prove the whole gated path
 * (audit -> PASS -> order placed) without risking trade capital. Point at
 * PRODUCTION explicitly, and only when you mean it.
 */
export const KALSHI_DEMO = "https://demo-api.kalshi.co/trade-api/v2";
export const KALSHI_PRODUCTION = "https://api.elections.kalshi.com/trade-api/v2";

export interface KalshiConfig {
  /** Kalshi API key ID. */
  apiKey: string;
  /**
   * RSA private key, PEM string. Kalshi signs every authenticated request
   * with RSA-PSS; the SDK does the signing, this is the key it signs with.
   * Use `privateKeyPath` instead to read it from disk.
   */
  privateKeyPem?: string;
  /** Path to the RSA private key PEM file. Alternative to `privateKeyPem`. */
  privateKeyPath?: string;
  /** API host. Defaults to KALSHI_DEMO. Pass KALSHI_PRODUCTION deliberately. */
  basePath?: string;
}

/** A Kalshi event-market order plus the thesis that justifies it. */
export interface GatedKalshiOrderParams {
  /** Market ticker, e.g. "KXFEDDECISION-26SEP-H0". */
  ticker: string;
  /**
   * `bid` buys YES, `ask` sells YES. Kalshi quotes both legs from the YES
   * side: selling YES is economically buying NO at (1 - price).
   */
  side: BookSide;
  /** Contract count as a fixed-point string, e.g. "10" or "10.00". */
  count: string;
  /** US dollar price as a fixed-point string, e.g. "0.64". */
  price: string;
  /**
   * The prediction-market trade thesis, in free text. This is the audited
   * input: it should state the claim, a SOURCED probability, the falsification
   * condition, and the edge vs. the market price. It is sent to djzs.ai as the
   * `intent` argument of `verify_pm_trade`.
   */
  thesis: string;
  timeInForce?: CreateOrderV2RequestTimeInForceEnum;
  selfTradePreventionType?: SelfTradePreventionType;
  clientOrderId?: string;
  postOnly?: boolean;
  subaccount?: number;
}

export interface GatedKalshiOrderResult {
  order: CreateOrderV2Response;
  /** The audit that authorized the trade. Always a clean in-scope PASS. */
  audit: VerifyPmTradeResult;
}

/**
 * GatedKalshiClient wires the DJZS reasoning audit in front of Kalshi's
 * event-market order entry.
 *
 *   1. audit the thesis with `verify_pm_trade` (2.00 USDC over x402 on Base)
 *   2. HALT on anything that is not a clean in-scope PASS
 *   3. only then create the order
 *
 * No API client is constructed and no order payload is built before the audit
 * returns PASS. A halted trade costs the audit fee and nothing else; an
 * out-of-scope thesis is refused by the gate for free.
 *
 * SCOPE. This gates Kalshi's EVENT-MARKET orders only (`/orders`, the V2
 * endpoint). It deliberately does not wrap Kalshi's separate perpetual-futures
 * (margin) order API. `verify_pm_trade` is a prediction-market tool and
 * answers a perp thesis with `in_scope: false` — correctly, and for free, but
 * it means a perps order routed here would never be audited. Perp auditing
 * ships separately.
 */
export class GatedKalshiClient {
  private readonly gate: DjzsGate;
  private readonly cfg: KalshiConfig;
  private orders: OrdersApi | null = null;

  constructor(gate: DjzsGate, config: KalshiConfig) {
    if (!config.privateKeyPem && !config.privateKeyPath) {
      throw new Error(
        "KalshiConfig requires privateKeyPem or privateKeyPath (RSA key for request signing)",
      );
    }
    this.gate = gate;
    this.cfg = config;
  }

  /** Build (once) the Kalshi orders client. Only called after a PASS. */
  private getOrders(): OrdersApi {
    if (this.orders) return this.orders;
    const configuration = new Configuration({
      apiKey: this.cfg.apiKey,
      privateKeyPem: this.cfg.privateKeyPem,
      privateKeyPath: this.cfg.privateKeyPath,
      basePath: this.cfg.basePath ?? KALSHI_DEMO,
    });
    this.orders = new OrdersApi(configuration);
    return this.orders;
  }

  /**
   * Audit the thesis, then place the order ONLY on a clean in-scope PASS.
   *
   * @throws {TradeHaltedError} on WAIT, FAIL, or out-of-scope. The error
   * carries the full audit result, including `verdict_hash` and
   * `unknown_fields`, so the caller can log the refusal and clarify.
   */
  async placeGatedOrder(
    params: GatedKalshiOrderParams,
  ): Promise<GatedKalshiOrderResult> {
    // ---- GATE 1: the thesis ---------------------------------------------
    const audit = await this.gate.verifyTrade(params.thesis);

    // HALT is the default. Nothing below this line runs otherwise: no client
    // is built, no order payload is constructed, no Kalshi request is made.
    if (!this.gate.shouldProceed(audit)) {
      throw new TradeHaltedError(audit);
    }

    // ---- GATE 2: the order ----------------------------------------------
    const request: CreateOrderV2Request = {
      ticker: params.ticker,
      side: params.side,
      count: params.count,
      price: params.price,
      time_in_force:
        params.timeInForce ?? CreateOrderV2RequestTimeInForceEnum.GoodTillCanceled,
      self_trade_prevention_type:
        params.selfTradePreventionType ?? SelfTradePreventionType.TakerAtCross,
      ...(params.clientOrderId ? { client_order_id: params.clientOrderId } : {}),
      ...(params.postOnly !== undefined ? { post_only: params.postOnly } : {}),
      ...(params.subaccount !== undefined ? { subaccount: params.subaccount } : {}),
    };

    const res = await this.getOrders().createOrderV2(request);
    return { order: res.data, audit };
  }

  /**
   * Audit a thesis without trading. Never throws on WAIT/FAIL, so it is the
   * right call for dry runs and for deciding whether to clarify a thesis
   * before committing to an order.
   */
  async auditOnly(thesis: string): Promise<VerifyPmTradeResult> {
    return this.gate.verifyTrade(thesis);
  }

  /** Access the underlying Kalshi orders client (cancels, lookups, etc). */
  getOrdersApi(): OrdersApi {
    return this.getOrders();
  }
}
