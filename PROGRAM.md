# autoresearch

This repo applies the autoresearch pattern to prediction markets.

Its job is not to trade. Its job is to improve forecasting judgment inside a fixed harness that a human can inspect.

## Thesis

Keep the plumbing frozen. Keep the evaluator frozen. Keep the history frozen. Let the agent change one thing: the forecasting policy in [`policy/current.md`](/Users/igorkudryk/Side%20Coding/autoedge/policy/current.md).

The repo is intentionally small:

- one mutable policy file
- one agent-driven forecaster
- one fixed historical evaluator
- one deciding score
- one read-only live publisher

Everything else is harness code.

## Ground Truth

The deciding metric is holdout average log loss on resolved Kalshi markets.

The loop is:

1. Read a fixed historical market snapshot.
2. Ask the current policy for a probability estimate.
3. Compare that estimate with the final outcome.
4. Compare the policy against the market baseline.
5. Keep a revised policy only if it strictly improves holdout log loss.

Live metrics are diagnostics. They are never the promotion criterion.

## Frozen Surfaces

These parts of the repo are fixed code and should not be rewritten by the improvement loop:

- Kalshi ingestion and normalization
- historical snapshot selection
- split manifest generation
- log-loss scoring
- artifact schemas and append-only ledgers
- Markdown and SVG report generation
- live disagreement publishing

The forecasting policy in [`policy/current.md`](/Users/igorkudryk/Side%20Coding/autoedge/policy/current.md) is the only mutable repo-tracked artifact in the learning loop.

## Frozen Modules

The fixed harness currently lives in explicit modules:

- `src/cli.ts`: command surface for `sync`, `backtest`, `improve`, `publish`, and `report`
- `src/workflows.ts`: orchestration for the full historical and live loop
- `src/kalshi.ts`: Kalshi market normalization and 24-hour snapshot extraction
- `src/agent.ts`: local `codex` or `claude` runner for forecasting and policy revision
- `src/scoring.ts`: log-loss scoring and training-error summaries
- `src/splits.ts`: chronological train/holdout manifest generation
- `src/storage.ts`: cache, ledgers, report files, and policy archive persistence
- `src/report.ts`: Markdown and SVG report generation
- `test/kalshi.test.ts`, `test/scoring.test.ts`, and `test/workflows.test.ts`: regression coverage for the frozen evaluator

## Concrete Artifacts

The harness now writes concrete cache and ledger files, not just directories:

- `artifacts/cache/historical-cutoff.json`
- `artifacts/cache/resolved-examples.json`
- `artifacts/cache/open-markets.json`
- `artifacts/splits/resolved-split.json`
- `artifacts/ledgers/experiments.jsonl`
- `artifacts/ledgers/live.jsonl`
- `artifacts/ledgers/policies.jsonl`
- `artifacts/reports/experiment-history.md`
- `artifacts/reports/live-disagreements.md`
- `artifacts/reports/experiment-trend.svg`

## Historical And Live Modes

Historical mode is the truth source.

- The evaluator uses resolved binary Kalshi markets only.
- Each resolved market contributes one example: the latest 60-minute candlestick ending at or before 24 hours before settlement.
- Markets without a valid 24-hour snapshot are skipped.

Live mode is read-only.

- It scans open binary markets.
- It compares the active policy estimate to the current market probability.
- It publishes the strongest disagreements into an append-only ledger plus generated Markdown.
- It backfills resolution events later when a previously published market settles.
- It never places orders, manages a wallet, routes execution, or touches capital.

## Improvement Rules

The improvement loop may:

- read the current policy
- read training-slice errors and experiment history
- propose a replacement policy
- evaluate that replacement on the frozen holdout set

The improvement loop may not:

- edit scoring logic
- edit data connectors
- edit storage or reports
- access raw holdout examples when proposing a candidate
- add trading logic
- move behavior out of the single policy file to escape the constraint

## Operator Workflow

The intended first local run is:

1. `npm run sync`
2. `npm test`
3. `npm run backtest -- --split holdout`
4. `npm run improve`
5. `npm run publish`
6. `npm run report`

This sequence should always answer three questions:

1. What policy made this prediction?
2. How did that policy score on resolved markets?
3. Where does the current policy disagree with the market right now?
