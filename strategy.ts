// strategy.ts — two-tier momentum bot for the pump.fun replay (paper trading only).
//
// Idea: most new pump.fun coins die fast, but the ones that run, run hard. So the
// bot splits its entries into two tiers, each decided once per coin, on the first
// batch where the coin's price multiple (current price / creation price) trips it:
//
//   Tier A (breadth): multiple >= 1.3x, size 0.01 SOL, take-profit +30%, stop-loss -10%.
//     Tiny size, so it can cover very many coins and clear the 20-coin round-trip
//     guardrail cheaply. One 0.01 SOL buy is exactly the minimum round-trip size.
//   Tier B (conviction): multiple >= 8.0x, size 0.60 SOL, take-profit +40%, stop-loss -30%.
//     Only coins that already proved an 8x run get real size; the wider stop gives
//     a runner room while the take-profit banks the move. A coin closed at Tier A
//     may still enter Tier B later, so an early small exit never loses a runner.
//
// Every position is exited in full by its own take-profit / stop-loss, checked on
// every batch. The harness closes anything left when a curve completes or the
// replay ends. No shorts, no leverage, no second buy on the same mint.
//
// The strategy is pure: it takes plain data and returns plain orders, so the same
// code runs under the harness adapter (main.ts) and under the offline replay
// simulator. It is fully deterministic — no randomness, no clock, no I/O — so two
// harness executions produce identical action logs.

export type Tier = 'A' | 'B';

export interface PlainCurve {
  mint: string;
  /** Current virtual quote (SOL) reserves, lamports. */
  vQuote: bigint;
  /** Current virtual token reserves. */
  vToken: bigint;
  /** Current real quote (SOL) reserves, lamports; drives the per-order size cap. */
  realQuote: bigint;
  /** True once the curve completed (no more orders allowed). */
  complete: boolean;
  /** Price (lamports per token) at creation, as a float ratio. */
  createPrice: number;
}

export interface PlainHolding {
  mint: string;
  tokens: bigint;
  /** SOL spent on the tokens still held, fees included. */
  costLamports: bigint;
  /** Entry price (lamports per token) at the decision batch. */
  entryPrice: number;
  tier: Tier;
  tpPrice: number;
  slPrice: number;
}

export interface PlainOrder {
  side: 'buy' | 'sell';
  mint: string;
  /** Buy: SOL to spend, curve fees included. */
  quoteLamports?: bigint;
  /** Sell: tokens to sell. */
  tokenAmount?: bigint;
  /** Buy only: tier decided, entry price and exit levels at the decision batch. */
  tier?: Tier;
  entryPrice?: number;
  tpPrice?: number;
  slPrice?: number;
}

export interface StrategyContext {
  curves: Map<string, PlainCurve>;
  positions: Map<string, PlainHolding>;
  /** Mints whose reserves moved in this batch, in first-appearance order. Only
      these can have crossed an entry multiple since the last batch, so entries
      only scan them (positions stay tiny, exits scan the holdings instead). */
  touchedMints: string[];
  cashLamports: bigint;
  maxOpenPositions: number;
  maxOrdersPerBatch: number;
  txFeeLamports: bigint;
  /** Per-order size cap for a mint now (1% of its real SOL reserve). */
  maxBuyLamports: (mint: string) => bigint;
  /** Mints with a buy already in flight (count against open positions). */
  pendingBuyMints: Set<string>;
  /** Cost already committed by in-flight buys (amount + tx fee each). */
  pendingBuyCostLamports: bigint;
}

export const TIER_A_MULTIPLE = 1.3;
export const TIER_A_SIZE_LAMPORTS = 10_000_000n; // 0.01 SOL
export const TIER_A_TP = 1.3; // +30%
export const TIER_A_SL = 0.9; // -10%

export const TIER_B_MULTIPLE = 8.0;
export const TIER_B_SIZE_LAMPORTS = 600_000_000n; // 0.60 SOL
export const TIER_B_TP = 1.4; // +40%
export const TIER_B_SL = 0.7; // -30%

export const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL, the round-trip guardrail

export function priceOf(curve: PlainCurve): number {
  if (curve.vToken <= 0n || curve.vQuote <= 0n) return 0;
  return Number(curve.vQuote) / Number(curve.vToken);
}

export interface TwoTierOptions {
  aMultiple: number;
  aSizeLamports: bigint;
  aTp: number;
  aSl: number;
  bMultiple: number;
  bSizeLamports: bigint;
  bTp: number;
  bSl: number;
}

export const DEFAULT_OPTIONS: TwoTierOptions = {
  aMultiple: TIER_A_MULTIPLE,
  aSizeLamports: TIER_A_SIZE_LAMPORTS,
  aTp: TIER_A_TP,
  aSl: TIER_A_SL,
  bMultiple: TIER_B_MULTIPLE,
  bSizeLamports: TIER_B_SIZE_LAMPORTS,
  bTp: TIER_B_TP,
  bSl: TIER_B_SL,
};

export class TwoTierBot {
  readonly opts: TwoTierOptions;
  /** Mints already bought (or skipped for good) at Tier A. */
  readonly decidedA = new Set<string>();
  /** Mints already bought (or skipped for good) at Tier B. A coin bought at
      Tier A and closed may still be bought at Tier B later: the tiers are
      decided independently, so a runner is not lost to an early small exit. */
  readonly decidedB = new Set<string>();

  constructor(opts: Partial<TwoTierOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  onBatch(ctx: StrategyContext): PlainOrder[] {
    const orders: PlainOrder[] = [];
    const tx = ctx.txFeeLamports;

    // 1) Exits first: full sell at take-profit or stop-loss.
    for (const holding of ctx.positions.values()) {
      if (orders.length >= ctx.maxOrdersPerBatch) break;
      const curve = ctx.curves.get(holding.mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve);
      if (price <= 0) continue;
      if (price >= holding.tpPrice || price <= holding.slPrice) {
        orders.push({ side: 'sell', mint: holding.mint, tokenAmount: holding.tokens });
      }
    }

    // 2) Entries: one buy per mint per tier, tier by first tripped multiple.
    // Tier B is checked first: a coin jumping straight past 8x is a B coin.
    let free = ctx.cashLamports - ctx.pendingBuyCostLamports;
    let committed = ctx.positions.size + ctx.pendingBuyMints.size;
    for (const mint of ctx.touchedMints) {
      if (orders.length >= ctx.maxOrdersPerBatch) break;
      if (committed >= ctx.maxOpenPositions) break;
      const curve = ctx.curves.get(mint);
      if (curve === undefined) continue;
      if (ctx.positions.has(mint) || ctx.pendingBuyMints.has(mint)) continue;
      if (curve.complete) continue;
      const price = priceOf(curve);
      if (price <= 0 || curve.createPrice <= 0) continue;
      const multiple = price / curve.createPrice;
      let tier: Tier | null = null;
      let desired = 0n;
      let tpMult = 1;
      let slMult = 1;
      if (multiple >= this.opts.bMultiple && !this.decidedB.has(mint)) {
        tier = 'B';
        desired = this.opts.bSizeLamports;
        tpMult = this.opts.bTp;
        slMult = this.opts.bSl;
      } else if (multiple >= this.opts.aMultiple && !this.decidedA.has(mint)) {
        tier = 'A';
        desired = this.opts.aSizeLamports;
        tpMult = this.opts.aTp;
        slMult = this.opts.aSl;
      }
      if (tier === null) continue;
      const cap = ctx.maxBuyLamports(mint);
      const amount = desired < cap ? desired : cap;
      if (amount < MIN_BUY_LAMPORTS) {
        // Cap can never fund a guardrail-sized round trip on this coin: skip for good.
        if (tier === 'A') this.decidedA.add(mint);
        else this.decidedB.add(mint);
        continue;
      }
      if (free < amount + tx) continue; // cash short: retry next batch, coin stays undecided.
      const tp = price * tpMult;
      const sl = price * slMult;
      orders.push({ side: 'buy', mint, quoteLamports: amount, tier, entryPrice: price, tpPrice: tp, slPrice: sl });
      if (tier === 'A') this.decidedA.add(mint);
      else this.decidedB.add(mint);
      free -= amount + tx;
      committed += 1;
    }
    return orders;
  }
}
