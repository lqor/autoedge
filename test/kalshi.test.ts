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
});
