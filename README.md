# Pump Replay Sprint Bot — Two-Tier Momentum (Paper Trading)

[![Competition](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/raesyafajarp-alt/pump-replay-sprint-bot/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/raesyafajarp-alt/pump-replay-sprint-bot/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the **Pump.fun Replay Sprint — Paper Bot, Real Ranking**
competition. It trades 10 SOL of paper money on a 24h replay of pump.fun
bonding-curve activity. Nothing is traded for real. Entry: `main.ts` (Node 22),
harness `pumpfun-replay/v2`.

## Strategy: two-tier momentum

Most new pump.fun coins die fast; the ones that run, run hard. The bot splits
entries into two tiers, each decided once per coin, on the first batch where the
coin's price multiple (current price / creation price) trips a tier:

| Tier | Entry multiple | Size | Take-profit | Stop-loss |
|------|---------------|------|-------------|-----------|
| A — breadth | >= 1.3x | 0.01 SOL | +30% | -10% |
| B — conviction | >= 8.0x | 0.60 SOL | +40% | -30% |

- **Tier A** is tiny on purpose: it covers very many coins cheaply and clears
  the 20-coin round-trip guardrail (one 0.01 SOL buy is exactly the minimum
  round-trip size).
- **Tier B** only backs coins that already proved an 8x run, with a wider stop
  so a runner has room. A coin closed at Tier A may still enter Tier B later,
  so an early small exit never loses a runner.
- Every position is exited in full at its own take-profit or stop-loss, checked
  on every batch. No shorts, no leverage, at most 5 open positions, one buy per
  mint per tier, buys capped at 1% of the coin's real SOL reserve.
- Fully deterministic: no randomness, no clock, no I/O, so two harness
  executions produce identical action logs.

## Layout

- `main.ts` — harness adapter: speaks `agent-fun/replay/v2` via the vendored
  SDK shim and drives the strategy once per batch.
- `strategy.ts` — the pure decision logic (no SDK dependency), shared with the
  offline simulator.
- `vendor/makefun-bot.ts` — the kit's SDK shim, byte-identical to the kit's
  `sdk/ts/makefun-bot.ts`.

## Offline backtest (dev dataset, own simulator)

Validated on the kit's dev dataset (150,000 events, 1,222 coins) with an
independent replay simulator: constant-product fills, 1.25% curve fees,
105,000 lamports tx fee per order, 1-batch execution delay, harness caps.

- **Net PnL: +1.2282 SOL (+12.28% on 10 SOL)**
- **Max drawdown: 12.07%** (guardrail: <= 50%)
- **570 buys** (549 Tier A + 21 Tier B), **550 round trips / 550 distinct mints**
  (guardrail: >= 20)
- 163 take-profit sells / 406 stop-loss sells; top-3 coins +0.82 SOL, rest +0.41 SOL
- Robust to latency: with a 2-batch execution delay the same parameters score
  +1.2113 SOL. Entering Tier B at 5x instead of 8x loses money (-2.81 SOL),
  so the 8x bar stays.

The dev window is one small sample, not a forecast of the final window.

## License

MIT — see `LICENSE`.
