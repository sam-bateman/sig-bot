// Pure position-limit math. Sizes are in shares; a bid buys YES (+), an ask sells YES (-).

export interface RiskLimits {
  maxLegShares: number;
  maxRaceDelta: number;
}

// Largest size for one order on leg `i` that keeps the leg's position and the race delta inside
// limits, assuming every resting order on that side also fills.
export function maxOrderSize(
  side: 'bid' | 'ask',
  netYes: number[],
  restingSameSide: number[],
  i: number,
  limits: RiskLimits,
): number {
  const n = netYes.length;
  const mean = netYes.reduce((a, b) => a + b, 0) / n;
  const delta = netYes[i]! - mean;
  const resting = restingSameSide[i] ?? 0;
  // Trading s shares on one leg moves that leg's delta by s * (1 - 1/n).
  const deltaPerShare = 1 - 1 / n;
  if (side === 'bid') {
    const byLeg = limits.maxLegShares - netYes[i]! - resting;
    const byDelta = (limits.maxRaceDelta - delta) / deltaPerShare - resting;
    return Math.max(0, Math.floor(Math.min(byLeg, byDelta) + 1e-9));
  }
  const byLeg = limits.maxLegShares + netYes[i]! - resting;
  const byDelta = (limits.maxRaceDelta + delta) / deltaPerShare - resting;
  return Math.max(0, Math.floor(Math.min(byLeg, byDelta) + 1e-9));
}

// Capital an order ties up: YES costs its price, NO costs one minus it.
export function orderCost(side: 'bid' | 'ask', priceT: number, quantity: number, ticksPerUnit = 200): number {
  const p = priceT / ticksPerUnit;
  return (side === 'bid' ? p : 1 - p) * quantity;
}
