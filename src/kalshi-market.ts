import {
  Configuration,
  MarketApi,
  MarketStatusEnum,
  type GetMarketOrderbookResponse,
  type Market,
} from "kalshi-typescript";
import { KALSHI_DEMO, KALSHI_PRODUCTION } from "./kalshi.js";

/**
 * A quote, normalized to numbers, plus the one thing a thesis-writer actually
 * needs to know: whether this is a real two-sided book.
 */
export interface KalshiQuote {
  ticker: string;
  title: string;
  status: MarketStatusEnum;
  closeTime: string;
  /** Dollars, e.g. 0.93. NaN when the field did not parse. */
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  lastPrice: number;
  /**
   * (yesAsk + noAsk) in CENTS. On a real book the two asks sum to just over
   * 100c — the spread is the market's cut. See `bookLooksReal`.
   */
  sidesSum: number;
  /** sidesSum <= 110c. False when the sum is absurd OR unparseable. */
  bookLooksReal: boolean;
  /** status === "active". A closed market quotes stale prices forever. */
  tradeable: boolean;
  /** The untouched SDK model, for anything this interface does not surface. */
  raw: Market;
}

export interface ListMarketsParams {
  eventTicker?: string;
  limit?: number;
}

/** Parse a `*_dollars` fixed-point string. Unparseable stays NaN — never 0. */
function parseDollars(value: string | undefined): number {
  if (value === undefined || value === null || value === "") return NaN;
  return Number.parseFloat(value);
}

function fmt(dollars: number): string {
  if (!Number.isFinite(dollars)) return "n/a";
  return `$${dollars.toFixed(2)} (${Math.round(dollars * 100)}c)`;
}

/**
 * KalshiMarketReader — read-only market data over the SDK's `MarketApi`.
 *
 * NO AUTHENTICATION. Kalshi's market endpoints are public, and the SDK's
 * `BaseAPI` only installs its request-signing interceptor when an apiKey AND a
 * private key are both configured. Passing neither leaves every request
 * unsigned, which is exactly right for reads: no key, no key custody problem,
 * nothing to leak. This class cannot place, cancel, or modify an order — it
 * only ever calls GET endpoints, and it spends nothing.
 *
 * WHY THIS EXISTS
 * ---------------
 * `verify_pm_trade` audits a thesis, and a thesis must cite the price you can
 * ACTUALLY TRADE AT: the real executable ask on the side you intend to take.
 * The failure mode this class exists to prevent is inferring one side of the
 * book from the other — quoting NO as `1 - yesBid` because it looks like it
 * ought to be. On a real book that arithmetic is roughly true. On a book with
 * no liquidity it is fiction, and a thesis built on it cites a price no
 * counterparty ever offered. The engine cannot catch this: a fabricated price
 * is a well-formed number, and M03 checks that a probability basis is STATED,
 * not that it is TRUE. Provenance is the caller's duty.
 *
 * VERIFIED LIVE. On production, KXBTCMAXMON's two asks summed to 101-102c —
 * a real book, where the ~1-2c over par is the spread. The DEMO book for the
 * same market quoted YES 93 + NO 99 = 192c. Those are not two prices of one
 * instrument; they are two unrelated numbers on a synthetic book with no
 * counterparties. A thesis citing the demo ask would be sourced to nothing.
 * `sidesSum` and `bookLooksReal` exist to make that visible before it reaches
 * an audit.
 *
 * DEFAULTS TO PRODUCTION, deliberately — the opposite of `GatedKalshiClient`,
 * which defaults to demo. The two defaults are chosen by RISK, not by habit:
 * writes can lose money, so they default to the exchange where they cannot;
 * reads are free and risk-free, and only production quotes reflect a real
 * book. Reading demo prices is not a safer version of reading production
 * prices, it is a wrong version. Use `KalshiMarketReader.demo()` when you
 * specifically want to inspect the demo exchange.
 */
export class KalshiMarketReader {
  private readonly basePath: string;
  private api: MarketApi | null = null;

  constructor(basePath: string = KALSHI_PRODUCTION) {
    this.basePath = basePath;
  }

  /**
   * Read from the DEMO exchange. Its books are synthetic — see the class note.
   * Useful for exercising this client, never for sourcing a thesis price.
   */
  static demo(): KalshiMarketReader {
    return new KalshiMarketReader(KALSHI_DEMO);
  }

  /** Which host this reader is pointed at. */
  getBasePath(): string {
    return this.basePath;
  }

  /** True when reading the demo exchange, whose prices are not real quotes. */
  isDemo(): boolean {
    return this.basePath === KALSHI_DEMO;
  }

  /**
   * Build the API client once. The SDK registers an axios request interceptor
   * per BaseAPI construction, so constructing it repeatedly would stack them.
   */
  private getApi(): MarketApi {
    if (this.api) return this.api;
    // No apiKey and no private key: requests go out unsigned.
    this.api = new MarketApi(new Configuration({ basePath: this.basePath }));
    return this.api;
  }

  /** Full market model for one ticker. */
  async getMarket(ticker: string): Promise<Market> {
    const res = await this.getApi().getMarket(ticker);
    return res.data.market;
  }

  /** Raw orderbook. `depth` limits price levels per side. */
  async getOrderbook(ticker: string, depth?: number): Promise<GetMarketOrderbookResponse> {
    const res = await this.getApi().getMarketOrderbook(ticker, depth);
    return res.data;
  }

  /** Markets, optionally scoped to one event. */
  async listMarkets(params: ListMarketsParams = {}): Promise<Market[]> {
    const { eventTicker, limit } = params;
    const res = await this.getApi().getMarkets(limit, undefined, eventTicker);
    return res.data.markets;
  }

  /**
   * The quote a thesis should cite. Prices come from the market model's
   * `*_dollars` fields — both sides read independently off the book, never
   * derived from each other.
   */
  async quote(ticker: string): Promise<KalshiQuote> {
    const market = await this.getMarket(ticker);

    const yesBid = parseDollars(market.yes_bid_dollars);
    const yesAsk = parseDollars(market.yes_ask_dollars);
    const noBid = parseDollars(market.no_bid_dollars);
    const noAsk = parseDollars(market.no_ask_dollars);
    const lastPrice = parseDollars(market.last_price_dollars);

    const sidesSum = Math.round((yesAsk + noAsk) * 100);
    // An unparseable side must NOT read as a real book: NaN <= 110 is false,
    // but state it explicitly so the intent survives a future refactor.
    const bookLooksReal = Number.isFinite(sidesSum) && sidesSum <= 110;

    return {
      ticker: market.ticker,
      title: market.title ?? "",
      status: market.status,
      closeTime: market.close_time,
      yesBid,
      yesAsk,
      noBid,
      noAsk,
      lastPrice,
      sidesSum,
      bookLooksReal,
      tradeable: market.status === MarketStatusEnum.Active,
      raw: market,
    };
  }

  /**
   * One line, ready to paste into a thesis as the price citation.
   *
   * When the book does not look real the line says so, loudly and inline, so
   * the warning travels with the number instead of being lost between reading
   * the quote and writing the thesis.
   */
  async quoteLine(ticker: string): Promise<string> {
    const q = await this.quote(ticker);

    const parts = [
      `${q.ticker}${q.title ? ` "${q.title}"` : ""}`,
      `YES bid ${fmt(q.yesBid)} / ask ${fmt(q.yesAsk)}`,
      `NO bid ${fmt(q.noBid)} / ask ${fmt(q.noAsk)}`,
      `asks sum ${Number.isFinite(q.sidesSum) ? `${q.sidesSum}c` : "n/a"}`,
      `last ${fmt(q.lastPrice)}`,
      `status ${q.status}${q.tradeable ? "" : " (NOT TRADEABLE)"}`,
      `closes ${q.closeTime}`,
    ];

    let line = parts.join(" | ");
    if (!q.bookLooksReal) line += " (NOT A REAL TWO-SIDED BOOK)";
    return line;
  }
}
