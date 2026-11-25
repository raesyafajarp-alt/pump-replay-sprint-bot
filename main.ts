// main.ts — pump.fun replay bot: two-tier momentum, paper trading only.
//
// Entry point run by the grader as `node /bot/main.ts`. The decision logic lives
// in strategy.ts (pure, shared with the offline simulator); this file only adapts
// the harness SDK state (vendor/makefun-bot.ts, a copy of the kit's sdk/ts) to it
// and back. Every batch the bot answers with at most one reply: exits first,
// then entries, within the hello caps.
//
// hello / batch / orders / slot: the harness speaks in batches, one reply per
// batch, each order carrying the slot it was decided on.

import { runBot, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bot.ts';
import { TwoTierBot, priceOf, type PlainCurve, type PlainHolding, type StrategyContext } from './strategy.ts';

const MAX_SLIPPAGE_BPS = 10_000;

const bot = new TwoTierBot();
/** Creation price per mint (lamports per token), from its CreateEvent. */
const createPrices = new Map<string, number>();
/** Buys sent but not yet filled: mint -> exit levels decided at entry. */
const pendingEntries = new Map<string, { entryPrice: number; tier: 'A' | 'B'; tpPrice: number; slPrice: number }>();
/** Filled positions with their entry levels. */
const entries = new Map<string, { entryPrice: number; tier: 'A' | 'B'; tpPrice: number; slPrice: number }>();

await runBot({
  onBatch(state, batch) {
    // Learn creation prices from this batch's events before deciding.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent' && !createPrices.has(e.mint)) {
        const vq = Number(e.virtual_quote_reserves);
        const vt = Number(e.virtual_token_reserves);
        if (vq > 0 && vt > 0) createPrices.set(e.mint, vq / vt);
      }
    }

    // Fold fills into entries: a buy that filled since the last batch starts
    // being managed; a sell (or harness close) drops the entry.
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'filled') {
        const pending = pendingEntries.get(fill.mint);
        if (pending !== undefined) {
          entries.set(fill.mint, pending);
          pendingEntries.delete(fill.mint);
        }
      } else if (fill.side === 'buy') {
        pendingEntries.delete(fill.mint); // rejected / failed: no position to manage.
      } else if (fill.side === 'sell' && fill.status === 'filled') {
        entries.delete(fill.mint);
      }
    }
    // Harness closes (_complete_ / _flatten_ / _writeoff_) arrive as sell fills
    // too; anything the account no longer holds is dropped below.

    // Build the plain context the strategy decides on.
    const curves = new Map<string, PlainCurve>();
    for (const [mint, curve] of state.curves) {
      let createPrice = createPrices.get(mint);
      if (createPrice === undefined) {
        // First seen through a trade or a mark: use its first known price.
        const vq = Number(curve.virtual_quote_reserves);
        const vt = Number(curve.virtual_token_reserves);
        createPrice = vq > 0 && vt > 0 ? vq / vt : 0;
        if (createPrice > 0) createPrices.set(mint, createPrice);
      }
      curves.set(mint, {
        mint,
        vQuote: curve.virtual_quote_reserves,
        vToken: curve.virtual_token_reserves,
        realQuote: curve.real_quote_reserves,
        complete: curve.complete,
        createPrice,
      });
    }

    const positions = new Map<string, PlainHolding>();
    for (const [mint, holding] of state.positions) {
      const entry = entries.get(mint);
      if (entry === undefined) continue; // fill not yet attributed; manage next batch.
      positions.set(mint, {
        mint,
        tokens: holding.token_amount,
        costLamports: holding.cost_lamports,
        entryPrice: entry.entryPrice,
        tier: entry.tier,
        tpPrice: entry.tpPrice,
        slPrice: entry.slPrice,
      });
    }
    // Drop entries for positions the account no longer holds (harness closes).
    for (const mint of [...entries.keys()]) {
      if (!state.positions.has(mint)) entries.delete(mint);
    }

    const pendingBuyMints = new Set<string>();
    let pendingBuyCost = 0n;
    const tx = state.txFeeLamports();
    for (const pending of state.pending.values()) {
      pendingBuyCost += tx;
      if (pending.order.side === 'buy') {
        pendingBuyMints.add(pending.order.mint);
        pendingBuyCost += BigInt(pending.order.quote_lamports);
      }
    }

    const ctx: StrategyContext = {
      curves,
      positions,
      touchedMints: [...new Set(batch.events.map((e) => e.mint))],
      cashLamports: state.cash,
      maxOpenPositions: state.hello.caps.max_open_positions,
      maxOrdersPerBatch: state.hello.caps.max_orders_per_batch,
      txFeeLamports: tx,
      maxBuyLamports: (mint) => state.maxBuyLamports(mint),
      pendingBuyMints,
      pendingBuyCostLamports: pendingBuyCost,
    };

    const plain = bot.onBatch(ctx);
    const orders: OrderInput[] = [];
    for (const order of plain) {
      if (order.side === 'buy') {
        pendingEntries.set(order.mint, {
          entryPrice: order.entryPrice ?? priceOf(curves.get(order.mint)!),
          tier: order.tier ?? 'A',
          tpPrice: order.tpPrice ?? 0,
          slPrice: order.slPrice ?? 0,
        });
        const buy: BuyInput = {
          side: 'buy',
          mint: order.mint,
          quote_lamports: order.quoteLamports ?? 0n,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        orders.push(buy);
      } else {
        const sell: SellInput = {
          side: 'sell',
          mint: order.mint,
          token_amount: order.tokenAmount ?? 0n,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        orders.push(sell);
      }
    }
    return orders;
  },
});
