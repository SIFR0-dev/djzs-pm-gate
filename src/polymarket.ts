import { ClobClient, OrderType, Side, type TickSize } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { DjzsGate } from "./gate.js";
import { TradeHaltedError, type VerifyPmTradeResult } from "./types.js";

export interface PolymarketConfig {
  /** CLOB host. Default: https://clob.polymarket.com */
  host?: string;
  /** Private key for the wallet that signs Polymarket orders. */
  privateKey: `0x${string}`;
  /** 0 = browser wallet (MetaMask, Coinbase Wallet), 1 = Magic/email login. Default 1. */
  signatureType?: 0 | 1;
  /** Polymarket profile address (where USDC is held). Required for signatureType 1. */
  funder?: string;
  /** Chain id. Polymarket = 137 (Polygon). */
  chainId?: number;
}

export interface GatedOrderParams {
  /** CLOB token id for the YES/NO outcome you want to buy. */
  tokenID: string;
  /** Limit price, 0..1 (e.g. 0.55 = 55¢). */
  price: number;
  side: Side;
  /** Number of shares. */
  size: number;
  /**
   * The free-text prediction-market trade thesis the agent is acting on. This
   * is what djzs.ai audits — it must state the claim, the sourced
   * probability, and the falsification condition. It is NOT the order params.
   */
  thesis: string;
}

export interface GatedOrderOptions {
  /** Tick size from the market metadata ("0.1" | "0.01" | "0.001" | "0.0001"). */
  tickSize: TickSize;
  /** negRisk flag from the market metadata. */
  negRisk: boolean;
}

export interface GatedOrderResult {
  /** The Polymarket CLOB response (order id / status). */
  order: unknown;
  /** The djzs.ai audit that authorized the trade. */
  audit: VerifyPmTradeResult;
}

/**
 * GatedClobClient wraps the official `@polymarket/clob-client` so that every
 * order is audited by djzs.ai before it is created or posted.
 *
 * Flow:
 *   1. build thesis  ->  2. djzs.ai verify_pm_trade  ->  3. on PASS, createAndPostOrder
 *
 * WAIT / FAIL / out-of-scope raise `TradeHaltedError` and no order is created.
 */
export class GatedClobClient {
  private clobPromise: Promise<ClobClient> | null = null;

  constructor(private readonly gate: DjzsGate, private readonly config: PolymarketConfig) {}

  /**
   * Lazily build the ClobClient. Only called after a PASS, so no Polymarket
   * side effects (API-key derivation) happen before the audit clears.
   */
  private async getClob(): Promise<ClobClient> {
    if (!this.clobPromise) {
      const { host, chainId, signatureType, funder, privateKey } = this.resolveConfig();
      const signer = new Wallet(privateKey);
      this.clobPromise = (async () => {
        const bootstrap = new ClobClient(host, chainId, signer);
        const creds = await bootstrap.createOrDeriveApiKey();
        return new ClobClient(host, chainId, signer, creds, signatureType, funder);
      })();
    }
    return this.clobPromise;
  }

  private resolveConfig() {
    const c = this.config;
    return {
      host: c.host ?? "https://clob.polymarket.com",
      chainId: c.chainId ?? 137,
      signatureType: c.signatureType ?? 1,
      funder: c.funder ?? "",
      privateKey: c.privateKey,
    };
  }

  /**
   * Audit the thesis with djzs.ai, then — only on PASS — create and post the
   * Polymarket order. Throws `TradeHaltedError` on WAIT/FAIL/out-of-scope.
   */
  async placeGatedOrder(
    params: GatedOrderParams,
    options: GatedOrderOptions,
    orderType: OrderType.GTC | OrderType.GTD = OrderType.GTC,
  ): Promise<GatedOrderResult> {
    const audit = await this.gate.verifyTrade(params.thesis);
    if (!this.gate.shouldProceed(audit)) {
      throw new TradeHaltedError(audit);
    }

    const clob = await this.getClob();
    const order = await clob.createAndPostOrder(
      {
        tokenID: params.tokenID,
        price: params.price,
        side: params.side,
        size: params.size,
      },
      { tickSize: options.tickSize, negRisk: options.negRisk },
      orderType,
    );

    return { order, audit };
  }

  /** Access the underlying ClobClient for market reads, order books, etc. */
  async getClobClient(): Promise<ClobClient> {
    return this.getClob();
  }
}
