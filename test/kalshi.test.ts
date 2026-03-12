import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { normalizeCandle, normalizeMarketMeta, selectSnapshotFromCandles } from "../src/kalshi.js";

describe("kalshi normalization", () => {
  it("normalizes an open market into a binary meta record", async () => {
    const fixture = JSON.parse(
      await fs.readFile(new URL("./fixtures/kalshi-market.json", import.meta.url), "utf8"),
    );

    const market = normalizeMarketMeta(fixture);
    expect(market).not.toBeNull();
    expect(market?.ticker).toBe("KXBTC-TEST");
    expect(market?.marketProbability).toBe(0.42);
    expect(market?.yesBid).toBe(0.41);
    expect(market?.yesAsk).toBe(0.43);
    expect(market?.isBinary).toBe(true);
  });

  it("selects the latest candle at or before the 24h horizon", async () => {
    const fixture = JSON.parse(
      await fs.readFile(new URL("./fixtures/kalshi-candles.json", import.meta.url), "utf8"),
    );

    const candles = fixture.map((entry: unknown) => normalizeCandle(entry)).filter(Boolean);
    const snapshot = selectSnapshotFromCandles(candles, "2026-03-15T16:05:00Z", 24);

    expect(snapshot?.endTime).toBe("2026-03-14T16:00:00.000Z");
    expect(snapshot?.probability).toBe(0.46);
  });

  it("normalizes current dollar-denominated market payloads", () => {
    const market = normalizeMarketMeta({
      ticker: "TEST-DOLLARS",
      title: "Dollar payload",
      market_type: "binary",
      result: "yes",
      event_ticker: "SERIES-1",
      yes_bid_dollars: "0.23",
      yes_ask_dollars: "0.27",
      no_bid_dollars: "0.73",
      no_ask_dollars: "0.77",
      last_price_dollars: "0.25",
      volume_fp: "12.00",
      liquidity_dollars: "45.00",
      open_interest_fp: "6.00",
      open_time: "2025-01-01T00:00:00Z",
      settlement_ts: "2025-01-03T00:00:00Z",
    });

    expect(market).not.toBeNull();
    expect(market?.marketProbability).toBe(0.25);
    expect(market?.openTime).toBe("2025-01-01T00:00:00.000Z");
    expect(market?.settlementTime).toBe("2025-01-03T00:00:00.000Z");
  });

  it("derives candle probability from nested yes bid and ask snapshots when trade price is absent", () => {
    const candle = normalizeCandle({
      end_period_ts: 1741723200,
      volume: "0.00",
      open_interest: "0.00",
      price: {
        close: null,
      },
      yes_bid: {
        close: "0.20",
      },
      yes_ask: {
        close: "0.40",
      },
    });

    expect(candle).not.toBeNull();
    expect(candle?.endTime).toBe("2025-03-11T20:00:00.000Z");
    expect(candle?.probability).toBe(0.3);
  });
});
