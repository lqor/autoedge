import type { AppConfig } from "./config.js";
import type { BinaryOutcome, MarketSnapshot, ResolvedExample } from "./types.js";
import {
  coercePrice,
  firstDefined,
  mapConcurrent,
  parseOptionalNumber,
  roundToSix,
  toIso,
} from "./utils.js";

export interface HttpClient {
  getJson(url: string, init?: RequestInit): Promise<unknown>;
  postJson?(url: string, body: unknown, init?: RequestInit): Promise<unknown>;
}

interface NormalizedMarketMeta {
  marketId: string;
  ticker: string;
  seriesTicker?: string;
  title: string;
  subtitle?: string;
  rules?: string;
  category?: string;
  status?: string;
  marketProbability: number | null;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  lastPrice: number | null;
  volume: number | null;
  liquidity: number | null;
  openInterest: number | null;
  closeTime?: string;
  resolveTime?: string;
  settlementTime?: string;
  outcome: BinaryOutcome | null;
  isBinary: boolean;
}

interface NormalizedCandle {
  endTime: string;
  probability: number;
  volume: number | null;
}

export class KalshiClient {
  constructor(
    private readonly config: AppConfig,
    private readonly http: HttpClient = createDefaultHttpClient(config.kalshiExtraHeaders),
  ) {}

  async getHistoricalCutoff(): Promise<string | null> {
    try {
      const response = (await this.http.getJson(this.buildLiveUrl("/historical/cutoff"))) as {
        cutoff_ts?: unknown;
        cutoff?: unknown;
      };

      return toIso(firstDefined(response.cutoff_ts, response.cutoff)) ?? null;
    } catch {
      return null;
    }
  }

  async fetchOpenSnapshots(): Promise<MarketSnapshot[]> {
    const rawMarkets =
      (await this.fetchMarkets("/markets", { status: "open", limit: this.config.openMarketLimit })) ||
      (await this.fetchMarkets("/markets", { limit: this.config.openMarketLimit })) ||
      [];

    return rawMarkets
      .map((record) => normalizeMarketMeta(record))
      .filter((meta): meta is NormalizedMarketMeta => Boolean(meta?.isBinary))
      .map((meta) => {
        if (meta.marketProbability === null) {
          throw new Error(`Open market ${meta.ticker} is missing a market probability`);
        }

        return {
          marketId: meta.marketId,
          ticker: meta.ticker,
          seriesTicker: meta.seriesTicker,
          title: meta.title,
          subtitle: meta.subtitle,
          rules: meta.rules,
          category: meta.category,
          status: meta.status,
          snapshotTime: new Date().toISOString(),
          closeTime: meta.closeTime,
          resolveTime: meta.resolveTime,
          marketProbability: meta.marketProbability,
          yesBid: meta.yesBid,
          yesAsk: meta.yesAsk,
          noBid: meta.noBid,
          noAsk: meta.noAsk,
          lastPrice: meta.lastPrice,
          volume: meta.volume,
          liquidity: meta.liquidity,
          openInterest: meta.openInterest,
          rawSource: "live",
        } satisfies MarketSnapshot;
      });
  }

  async fetchResolvedExamples(cutoffIso: string | null): Promise<ResolvedExample[]> {
    const historicalMarkets =
      (await this.fetchMarkets("/historical/markets", {
        status: "settled",
        limit: this.config.resolvedMarketLimit,
      })) ||
      (await this.fetchMarkets("/historical/markets", { limit: this.config.resolvedMarketLimit })) ||
      [];
    const recentMarkets =
      (await this.fetchMarkets("/markets", { status: "settled", limit: this.config.resolvedMarketLimit })) ||
      (await this.fetchMarkets("/markets", { limit: this.config.resolvedMarketLimit })) ||
      [];

    const merged = dedupeByTicker([...historicalMarkets, ...recentMarkets])
      .map((record) => normalizeMarketMeta(record))
      .filter((meta): meta is NormalizedMarketMeta => Boolean(meta?.isBinary && meta.outcome !== null))
      .filter((meta) => Boolean(meta.settlementTime));

    const examples = await mapConcurrent<NormalizedMarketMeta, ResolvedExample | null>(
      merged,
      this.config.syncConcurrency,
      async (meta) => {
      const useHistoricalEndpoint = shouldUseHistoricalEndpoint(meta.settlementTime!, cutoffIso);
      const candles = await this.fetchCandles(meta, useHistoricalEndpoint);
      const snapshot = selectSnapshotFromCandles(candles, meta.settlementTime!, 24);

      if (!snapshot) {
        return null;
      }

      return {
        marketId: meta.marketId,
        ticker: meta.ticker,
        ...(meta.seriesTicker ? { seriesTicker: meta.seriesTicker } : {}),
        title: meta.title,
        ...(meta.subtitle ? { subtitle: meta.subtitle } : {}),
        ...(meta.rules ? { rules: meta.rules } : {}),
        ...(meta.category ? { category: meta.category } : {}),
        ...(meta.status ? { status: meta.status } : {}),
        snapshotTime: snapshot.endTime,
        ...(meta.closeTime ? { closeTime: meta.closeTime } : {}),
        ...(meta.resolveTime ? { resolveTime: meta.resolveTime } : {}),
        marketProbability: snapshot.probability,
        yesBid: null,
        yesAsk: null,
        noBid: null,
        noAsk: null,
        lastPrice: snapshot.probability,
        volume: snapshot.volume,
        liquidity: meta.liquidity,
        openInterest: meta.openInterest,
        rawSource: useHistoricalEndpoint ? "historical" : "live",
        outcome: meta.outcome!,
        settlementTime: meta.settlementTime!,
      } satisfies ResolvedExample;
      },
    );

    return examples
      .filter((example): example is ResolvedExample => Boolean(example))
      .sort(
        (left, right) =>
          new Date(left.settlementTime).valueOf() - new Date(right.settlementTime).valueOf(),
      );
  }

  private async fetchMarkets(
    path: string,
    query: Record<string, string | number | undefined>,
  ): Promise<unknown[] | null> {
    let cursor: string | undefined;
    const results: unknown[] = [];
    const targetLimit = typeof query.limit === "number" ? query.limit : Number(query.limit ?? 0);

    while (results.length < targetLimit) {
      const page = (await this.http.getJson(
        this.buildLiveUrl(path, {
          ...query,
          limit: Math.min(100, targetLimit - results.length),
          cursor,
        }),
      )) as {
        markets?: unknown[];
        cursor?: string | null;
      };

      const markets = page.markets ?? [];
      results.push(...markets);

      if (!page.cursor || markets.length === 0) {
        break;
      }

      cursor = page.cursor;
    }

    return results.length > 0 ? results : null;
  }

  private async fetchCandles(
    market: NormalizedMarketMeta,
    historical: boolean,
  ): Promise<NormalizedCandle[]> {
    const livePath = market.seriesTicker
      ? `/series/${market.seriesTicker}/markets/${market.ticker}/candlesticks`
      : `/markets/${market.ticker}/candlesticks`;
    const endpoint = historical ? `/historical/markets/${market.ticker}/candlesticks` : livePath;

    const response = (await this.http.getJson(
      this.buildLiveUrl(endpoint, { period_interval: 60 }),
    )) as { candlesticks?: unknown[]; candles?: unknown[] };

    const candles = firstDefined(response.candlesticks, response.candles) ?? [];

    return candles
      .map((candle) => normalizeCandle(candle))
      .filter((entry): entry is NormalizedCandle => Boolean(entry))
      .sort((left, right) => new Date(left.endTime).valueOf() - new Date(right.endTime).valueOf());
  }

  private buildLiveUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(pathname.replace(/^\//, ""), `${this.config.kalshiBaseUrl.replace(/\/$/, "")}/`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }
}

export function normalizeMarketMeta(record: unknown): NormalizedMarketMeta | null {
  if (!record || typeof record !== "object") {
    return null;
  }

  const raw = record as Record<string, unknown>;
  const marketId = String(firstDefined(raw.id, raw.market_id, raw.ticker) ?? "");
  const ticker = String(firstDefined(raw.ticker, raw.market_ticker, raw.id) ?? "");
  const title = String(firstDefined(raw.title, raw.question, raw.event_title, raw.ticker) ?? "");

  if (!marketId || !ticker || !title) {
    return null;
  }

  const outcome = normalizeOutcome(firstDefined(raw.result, raw.market_result, raw.outcome, raw.final_outcome));
  const marketType = String(firstDefined(raw.market_type, raw.type, raw.result_type) ?? "").toLowerCase();
  const isBinary = marketType ? marketType !== "scalar" : outcome !== null || !String(raw.result ?? "").includes("scalar");

  return {
    marketId,
    ticker,
    seriesTicker: stringifyOptional(firstDefined(raw.series_ticker, raw.event_ticker)),
    title,
    subtitle: stringifyOptional(firstDefined(raw.subtitle, raw.sub_title, raw.yes_sub_title)),
    rules: stringifyOptional(firstDefined(raw.rules_primary, raw.rules, raw.description)),
    category: stringifyOptional(firstDefined(raw.category, raw.market_category, raw.series_category)),
    status: stringifyOptional(firstDefined(raw.status, raw.market_status)),
    marketProbability: deriveMarketProbability(raw),
    yesBid: coercePrice(firstDefined(raw.yes_bid, raw.best_yes_bid, raw.bid)),
    yesAsk: coercePrice(firstDefined(raw.yes_ask, raw.best_yes_ask, raw.ask)),
    noBid: coercePrice(firstDefined(raw.no_bid, raw.best_no_bid)),
    noAsk: coercePrice(firstDefined(raw.no_ask, raw.best_no_ask)),
    lastPrice: coercePrice(firstDefined(raw.last_price, raw.last_traded_price, raw.price)),
    volume: parseOptionalNumber(firstDefined(raw.volume, raw.trade_volume, raw.total_volume)),
    liquidity: parseOptionalNumber(firstDefined(raw.liquidity, raw.open_interest_dollars)),
    openInterest: parseOptionalNumber(firstDefined(raw.open_interest, raw.position)),
    closeTime: toIso(firstDefined(raw.close_time, raw.close_ts, raw.expiration_time, raw.end_date)),
    resolveTime: toIso(firstDefined(raw.settlement_time, raw.resolve_time, raw.resolution_time, raw.expiration_time)),
    settlementTime: toIso(firstDefined(raw.settlement_time, raw.resolve_time, raw.resolution_time, raw.close_time)),
    outcome,
    isBinary,
  };
}

export function normalizeOutcome(value: unknown): BinaryOutcome | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["yes", "y", "true", "1", "won_yes", "above", "up"].includes(normalized)) {
    return 1;
  }

  if (["no", "n", "false", "0", "won_no", "below", "down"].includes(normalized)) {
    return 0;
  }

  return null;
}

export function normalizeCandle(value: unknown): NormalizedCandle | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const endTime = toIso(firstDefined(raw.end_period_ts, raw.end_ts, raw.period_end_ts, raw.time));
  const probability = deriveMarketProbability(raw, ["close", "last_price", "price", "yes_price"]);

  if (!endTime || probability === null) {
    return null;
  }

  return {
    endTime,
    probability,
    volume: parseOptionalNumber(firstDefined(raw.volume, raw.trade_volume)),
  };
}

export function selectSnapshotFromCandles(
  candles: NormalizedCandle[],
  settlementTimeIso: string,
  horizonHours: number,
): NormalizedCandle | null {
  const target = new Date(settlementTimeIso).valueOf() - horizonHours * 60 * 60 * 1000;
  const eligible = candles.filter((candle) => new Date(candle.endTime).valueOf() <= target);
  return eligible.length > 0 ? eligible[eligible.length - 1] : null;
}

function deriveMarketProbability(
  raw: Record<string, unknown>,
  explicitKeys: string[] = ["yes_price", "last_price", "last_traded_price", "price"],
): number | null {
  for (const key of explicitKeys) {
    const value = coercePrice(raw[key]);
    if (value !== null) {
      return roundToSix(value);
    }
  }

  const yesBid = coercePrice(firstDefined(raw.yes_bid, raw.best_yes_bid, raw.bid));
  const yesAsk = coercePrice(firstDefined(raw.yes_ask, raw.best_yes_ask, raw.ask));
  if (yesBid !== null && yesAsk !== null) {
    return roundToSix((yesBid + yesAsk) / 2);
  }

  const noBid = coercePrice(firstDefined(raw.no_bid, raw.best_no_bid));
  const noAsk = coercePrice(firstDefined(raw.no_ask, raw.best_no_ask));
  if (noBid !== null && noAsk !== null) {
    return roundToSix(1 - (noBid + noAsk) / 2);
  }

  return null;
}

function shouldUseHistoricalEndpoint(settlementTimeIso: string, cutoffIso: string | null): boolean {
  if (!cutoffIso) {
    return false;
  }

  return new Date(settlementTimeIso).valueOf() <= new Date(cutoffIso).valueOf();
}

function dedupeByTicker(records: unknown[]): unknown[] {
  const seen = new Set<string>();
  const deduped: unknown[] = [];

  for (const record of records) {
    if (!record || typeof record !== "object") {
      continue;
    }

    const ticker = String((record as Record<string, unknown>).ticker ?? "");
    if (!ticker || seen.has(ticker)) {
      continue;
    }

    seen.add(ticker);
    deduped.push(record);
  }

  return deduped;
}

function stringifyOptional(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const text = String(value).trim();
  return text ? text : undefined;
}

export function createDefaultHttpClient(extraHeaders: Record<string, string> = {}): HttpClient {
  return {
    async getJson(url, init) {
      const response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          ...extraHeaders,
          ...(init?.headers ?? {}),
        },
      });

      if (!response.ok) {
        throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
      }

      return response.json();
    },
  };
}
