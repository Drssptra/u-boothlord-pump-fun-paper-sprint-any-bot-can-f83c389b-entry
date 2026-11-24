// Pump.fun Paper Sprint — "floor-sniper" paper-trading bot.
//
// Strategy, designed from the dev dataset (24h, 1222 mints):
//   * A pump.fun bonding curve's price can never fall below its creation price:
//     virtual SOL reserves start at 30 SOL and real SOL reserves cannot go below 0,
//     so price = virtual_sol / virtual_token >= creation price, always. The
//     downside of buying a fresh coin near its creation price is therefore just
//     the round-trip fees (~2.5%) — while the upside runs to 14.7x at graduation
//     (23% of dev coins peaked >= 2x, 4% graduated).
//   * So: buy EVERY new coin early, while its price is still within 10% of its
//     creation price, scaling in up to TARGET_SOL per coin under the harness's
//     1%-of-real-reserve per-batch buy cap. Hold at most 5 coins at once.
//   * Exits: sell half at +60% over average entry cost; ride the rest with a
//     trailing stop (sell all on a 25% pullback from the peak, armed once the
//     peak is +50%); free the slot after 8000 slots (~53 min) if the coin never
//     moves. The long hold was picked by replaying the dev data: shorter holds
//     churn through duds and pay the round-trip fees too often, while a longer
//     hold still trades 24-32 coins per 6 hours (above the 20-coin bar).
//     Buying already-pumped coins was tested and rejected: first-slot pumps
//     retrace to ~half their peak, so the bot never chases them.
//   * No stop-loss below entry is needed: the curve floor makes a deep loss
//     impossible, and a stop would only churn fees.
//   * Fully deterministic: no clock, no environment, no randomness; every
//     decision is a pure function of the harness state. Iteration order follows
//     the shim's insertion-ordered maps.
//
// Paper trading only: no network, no real funds. Runs under `node main.ts`
// via the agent-fun/replay/v2 harness (see vendor/makefun-bot.ts).

import { runBot, type BotState, type Batch, type OrderInput } from './vendor/makefun-bot.ts';

// ---- tuned parameters (from offline replay of the kit's dev dataset) ----
const ENTRY_MAX_NUM = 110n; // buy only while price <= 110% of creation price
const ENTRY_MAX_DEN = 100n;
const TARGET_SOL = 500_000_000n; // 0.5 SOL max cost per coin
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: also the guardrail's min round-trip buy
const TP1_NUM = 160n; // take-profit 1: sell half at +60% over average entry cost
const TP1_DEN = 100n;
const TP1_FRAC_NUM = 50n; // sell 50% of tokens at TP1
const TP1_FRAC_DEN = 100n;
const ARM_NUM = 150n; // trailing stop arms once the peak is +50% over entry
const ARM_DEN = 100n;
const TRAIL_NUM = 25n; // trailing stop: sell all on a 25% pullback from the peak
const TRAIL_DEN = 100n;
const MAX_HOLD_SLOTS = 8000; // free the slot if the coin never moves (~53 min)
const MAX_TRANCHES = 8; // scale-in at most 8 buys per coin
const BUY_GAP_SLOTS = 50; // at least 50 slots between scale-in buys of one coin
const MAX_SLIPPAGE_BPS = 500;

interface CoinInfo {
  /** Creation price as a fraction: virtual quote / virtual token at creation. */
  p0Num: bigint;
  p0Den: bigint;
  createSlot: number;
}

interface PositionInfo {
  /** Average entry cost in lamports per token, as cost/tokens. */
  cost: bigint;
  tokens: bigint;
  peakNum: bigint; // peak price as a fraction peakNum/peakDen
  peakDen: bigint;
  buySlot: number;
  sold1: boolean;
  tranches: number;
  lastBuySlot: number;
}

const coins = new Map<string, CoinInfo>();
const positions = new Map<string, PositionInfo>();
const entered = new Set<string>(); // fully exited mints: never re-enter
const buyCoolUntil = new Map<string, number>(); // mint -> slot until which buys are paused after a rejection

/** Compare a/b with c/d: -1, 0 or 1. All values non-negative bigints. */
function cmpFrac(aNum: bigint, aDen: bigint, bNum: bigint, bDen: bigint): number {
  const l = aNum * bDen;
  const r = bNum * aDen;
  return l < r ? -1 : l > r ? 1 : 0;
}

/** price >= entry * num/den, where entry = cost/tokens. */
function atOrAbove(
  vq: bigint,
  vt: bigint,
  cost: bigint,
  tokens: bigint,
  num: bigint,
  den: bigint,
): boolean {
  // vq/vt >= (cost/tokens) * (num/den)  <=>  vq * tokens * den >= vt * cost * num
  return vq * tokens * den >= vt * cost * num;
}

/** price <= p0 * num/den. */
function atOrBelowP0(vq: bigint, vt: bigint, p0Num: bigint, p0Den: bigint, num: bigint, den: bigint): boolean {
  // vq/vt <= (p0Num/p0Den) * (num/den)  <=>  vq * p0Den * den <= vt * p0Num * num
  return vq * p0Den * den <= vt * p0Num * num;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = state.slot;

    // Record each mint's creation price from this batch's events, IN ORDER.
    // (The shim has already folded the whole batch into state.curves, so a
    // coin created and pumped in one batch would read as already pumped there;
    // the CreateEvent's own reserves are the true creation price.)
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint) && BigInt(e.virtual_token_reserves) > 0n) {
          coins.set(e.mint, {
            p0Num: BigInt(e.virtual_quote_reserves),
            p0Den: BigInt(e.virtual_token_reserves),
            createSlot: e.slot,
          });
        }
      } else if (e.event === 'TradeEvent' && !coins.has(e.mint)) {
        // First sight is a trade (no CreateEvent delivered): recover the
        // pre-trade reserves, which are the creation price on a fresh curve.
        const vq = BigInt(e.virtual_quote_reserves);
        const vt = BigInt(e.virtual_token_reserves);
        const q = BigInt(e.quote_amount);
        const t = BigInt(e.token_amount);
        const preVq = e.is_buy ? vq - q : vq + q;
        const preVt = e.is_buy ? vt + t : vt - t;
        if (preVt > 0n && preVq > 0n) {
          coins.set(e.mint, { p0Num: preVq, p0Den: preVt, createSlot: e.slot });
        }
      }
    }

    // A rejected buy means the order never filled: pause re-attempts on that
    // mint for a while instead of retrying it every batch.
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status === 'rejected') {
        buyCoolUntil.set(f.mint, slot + 2000);
      }
    }

    // Sync positions with the harness account; drop coins the harness closed.
    for (const [mint, holding] of state.positions) {
      const prev = positions.get(mint);
      if (prev === undefined) {
        const info = coins.get(mint);
        positions.set(mint, {
          cost: holding.cost_lamports,
          tokens: holding.token_amount,
          peakNum: info ? info.p0Num : 1n,
          peakDen: info ? info.p0Den : 1n,
          buySlot: slot,
          sold1: false,
          tranches: 1,
          lastBuySlot: slot,
        });
      } else {
        prev.cost = holding.cost_lamports;
        prev.tokens = holding.token_amount;
      }
    }
    for (const mint of [...positions.keys()]) {
      if (!state.positions.has(mint)) {
        positions.delete(mint);
        entered.add(mint);
      }
    }

    // Update each position's peak price from the latest reserves.
    for (const [mint, pos] of positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (cmpFrac(curve.virtual_quote_reserves, curve.virtual_token_reserves, pos.peakNum, pos.peakDen) > 0) {
        pos.peakNum = curve.virtual_quote_reserves;
        pos.peakDen = curve.virtual_token_reserves;
      }
    }

    const pendingBuy = new Set<string>();
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuy.add(p.order.mint);
      else pendingSell.add(p.order.mint);
    }

    // ---- exits ----
    for (const [mint, pos] of positions) {
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      if (pos.tokens <= 0n || pos.cost <= 0n) continue;
      if (!pos.sold1 && atOrAbove(vq, vt, pos.cost, pos.tokens, TP1_NUM, TP1_DEN)) {
        const sellTokens = (pos.tokens * TP1_FRAC_NUM) / TP1_FRAC_DEN;
        if (sellTokens > 0n) {
          orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: MAX_SLIPPAGE_BPS });
          pos.sold1 = true;
        }
      } else if (
        atOrAbove(pos.peakNum, pos.peakDen, pos.cost, pos.tokens, ARM_NUM, ARM_DEN) &&
        // price <= peak * (1 - TRAIL)  <=>  vq/vt <= (peakNum/peakDen) * (TRAIL_DEN - TRAIL_NUM)/TRAIL_DEN
        vq * pos.peakDen * TRAIL_DEN <= vt * pos.peakNum * (TRAIL_DEN - TRAIL_NUM)
      ) {
        orders.push({ side: 'sell', mint, token_amount: pos.tokens, max_slippage_bps: MAX_SLIPPAGE_BPS });
      } else if (slot - pos.buySlot > MAX_HOLD_SLOTS) {
        orders.push({ side: 'sell', mint, token_amount: pos.tokens, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }

    const committed = new Set<string>(positions.keys());
    for (const m of pendingBuy) committed.add(m);
    // SOL already spoken for by orders built in this batch (buy amount + tx fee each).
    let reserved = 0n;
    const txFee = state.txFeeLamports();

    // ---- scale-in existing positions ----
    for (const [mint, pos] of positions) {
      if (orders.length >= 16) break;
      if (pendingBuy.has(mint) || pendingSell.has(mint)) continue;
      if (pos.tranches >= MAX_TRANCHES) continue;
      if (slot - pos.lastBuySlot < BUY_GAP_SLOTS) continue;
      if (pos.cost >= TARGET_SOL) continue;
      if ((buyCoolUntil.get(mint) ?? -1) > slot) continue;
      const curve = state.curves.get(mint);
      const info = coins.get(mint);
      if (curve === undefined || curve.complete || info === undefined) continue;
      if (!atOrBelowP0(curve.virtual_quote_reserves, curve.virtual_token_reserves, info.p0Num, info.p0Den, ENTRY_MAX_NUM, ENTRY_MAX_DEN)) continue;
      const cap = state.maxBuyLamports(mint);
      let amt = cap;
      const room = TARGET_SOL - pos.cost;
      if (amt > room) amt = room;
      // The fill pays the order's own tx fee on top of the spend, so the
      // spend must fit in the free cash AFTER that fee, or the fill is
      // rejected insufficient_cash and the bot retries it forever.
      const free = state.freeCashLamports() - reserved - txFee;
      if (amt > free) amt = free;
      if (amt >= MIN_BUY_LAMPORTS) {
        orders.push({ side: 'buy', mint, quote_lamports: amt, max_slippage_bps: MAX_SLIPPAGE_BPS });
        reserved += amt + txFee;
        pos.tranches += 1;
        pos.lastBuySlot = slot;
      }
    }

    // ---- enter new coins, oldest first ----
    if (committed.size < state.hello.caps.max_open_positions) {
      for (const [mint, info] of coins) {
        if (committed.size >= state.hello.caps.max_open_positions || orders.length >= 16) break;
        if (entered.has(mint) || positions.has(mint) || pendingBuy.has(mint)) continue;
        if ((buyCoolUntil.get(mint) ?? -1) > slot) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves <= 0n) continue;
        if (!atOrBelowP0(curve.virtual_quote_reserves, curve.virtual_token_reserves, info.p0Num, info.p0Den, ENTRY_MAX_NUM, ENTRY_MAX_DEN)) continue;
        const cap = state.maxBuyLamports(mint);
        let amt = cap;
        if (amt > TARGET_SOL) amt = TARGET_SOL;
        const free = state.freeCashLamports() - reserved - txFee;
        if (amt > free) amt = free;
        if (amt >= MIN_BUY_LAMPORTS) {
          orders.push({ side: 'buy', mint, quote_lamports: amt, max_slippage_bps: MAX_SLIPPAGE_BPS });
          reserved += amt + txFee;
          committed.add(mint);
        }
      }
    }

    return orders;
  },
});
