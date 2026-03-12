import { createHash, randomUUID } from "node:crypto";

export function clampProbability(probability: number, epsilon = 1e-6): number {
  if (!Number.isFinite(probability)) {
    throw new Error(`Probability must be finite, received ${probability}`);
  }

  if (probability < 0 || probability > 1) {
    throw new Error(`Probability must be between 0 and 1, received ${probability}`);
  }

  return Math.min(1 - epsilon, Math.max(epsilon, probability));
}

export function coercePrice(value: unknown): number | null {
  const parsed = parseOptionalNumber(value);
  if (parsed === null) {
    return null;
  }

  if (parsed > 1) {
    return roundToSix(parsed / 100);
  }

  if (parsed < 0) {
    return null;
  }

  return roundToSix(parsed);
}

export function parseOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function firstDefined<T>(...values: Array<T | undefined | null>): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return undefined;
}

export function toIso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  if (typeof value === "number") {
    return new Date(normalizeEpochMillis(value)).toISOString();
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    if (/^\d+$/.test(trimmed)) {
      return new Date(normalizeEpochMillis(Number(trimmed))).toISOString();
    }

    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toISOString();
    }
  }

  return undefined;
}

export function normalizeEpochMillis(value: number): number {
  if (value > 1e12) {
    return value;
  }

  return value * 1000;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function createRunId(prefix: string): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  return `${prefix}-${timestamp}-${randomUUID().slice(0, 8)}`;
}

export function roundToSix(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function formatPercent(probability: number): string {
  return `${(probability * 100).toFixed(1)}%`;
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () => worker());
  await Promise.all(workers);
  return results;
}

