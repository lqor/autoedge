export type Split = "train" | "holdout";
export type BinaryOutcome = 0 | 1;

export interface MarketSnapshot {
  marketId: string;
  ticker: string;
  seriesTicker?: string;
  title: string;
  subtitle?: string;
  rules?: string;
  category?: string;
  status?: string;
  snapshotTime: string;
  closeTime?: string;
  resolveTime?: string;
  marketProbability: number;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  lastPrice: number | null;
  volume: number | null;
  liquidity: number | null;
  openInterest: number | null;
  rawSource: "live" | "historical";
}

export interface ResolvedExample extends MarketSnapshot {
  outcome: BinaryOutcome;
  settlementTime: string;
  split?: Split;
}

export interface ForecastOutput {
  probability: number;
  rationale: string;
}

export interface ForecastResult extends ForecastOutput {
  marketId: string;
  ticker: string;
  title: string;
  policyVersionHash: string;
  marketProbability: number;
  disagreement: number;
  runId: string;
  timestamp: string;
  snapshot: MarketSnapshot;
}

export interface ScoredForecast extends ForecastResult {
  outcome: BinaryOutcome;
  policyLogLoss: number;
  marketLogLoss: number;
}

export interface EvaluationSummary {
  split: Split | "all";
  sampleCount: number;
  policyLogLoss: number;
  marketLogLoss: number;
  deltaVsMarket: number;
  examples: ScoredForecast[];
}

export interface PolicyVersion {
  hash: string;
  parentHash?: string;
  createdAt: string;
  sourceRunId?: string;
  filePath: string;
}

export interface ExperimentRun {
  runId: string;
  mode: "backtest" | "improve";
  timestamp: string;
  split: Split | "all" | "both";
  activePolicyHash: string;
  candidatePolicyHash: string;
  parentPolicyHash?: string;
  promoted: boolean;
  policyLogLoss: number;
  marketLogLoss: number;
  deltaVsParent: number | null;
  deltaVsMarket: number;
  holdoutPolicyLogLoss: number;
  holdoutMarketLogLoss: number;
  trainPolicyLogLoss: number | null;
  trainMarketLogLoss: number | null;
  trainingSummary?: string;
  sampleCount: number;
  candidatePath: string;
  model: string;
  notes?: string;
}

export interface PredictionEvent {
  type: "prediction";
  timestamp: string;
  runId: string;
  marketId: string;
  ticker: string;
  title: string;
  policyVersionHash: string;
  policyProbability: number;
  marketProbability: number;
  disagreement: number;
  rationale: string;
  snapshot: MarketSnapshot;
}

export interface ResolutionEvent {
  type: "resolution";
  timestamp: string;
  marketId: string;
  ticker: string;
  outcome: BinaryOutcome;
  settlementTime: string;
}

export type LiveLedgerEvent = PredictionEvent | ResolutionEvent;

export interface MaterializedLivePrediction {
  prediction: PredictionEvent;
  resolution?: ResolutionEvent;
  policyLogLoss?: number;
  marketLogLoss?: number;
}

export interface SplitManifest {
  createdAt: string;
  assignments: Record<string, Split>;
}

export interface SyncSummary {
  historicalCutoff: string | null;
  resolvedExamples: number;
  openMarkets: number;
  splitCreated: boolean;
}

