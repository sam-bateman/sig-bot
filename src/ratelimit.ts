// Token bucket refilling at perMin per minute. `take` waits until a token is free.
// Capacity is `burst`, not perMin: a bucket that idles up to perMin would allow ~2x perMin inside
// one sliding minute (a full bucket plus a full minute of refill), so any 60s window is capped
// at perMin + burst.
export class TokenBucket {
  private tokens: number;
  private last: number;
  private pausedUntil = 0;
  private readonly capacity: number;

  constructor(
    private readonly perMin: number,
    burst: number = Math.max(1, Math.ceil(perMin / 4)),
    private readonly now: () => number = Date.now,
  ) {
    this.capacity = burst;
    this.tokens = burst;
    this.last = now();
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 60_000) * this.perMin);
    this.last = t;
  }

  available(): number {
    this.refill();
    return this.now() < this.pausedUntil ? 0 : Math.floor(this.tokens);
  }

  // After a 429, stop spending until the server's Retry-After has passed.
  pause(ms: number) {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
    this.tokens = 0;
  }

  waitMs(): number {
    this.refill();
    const pause = Math.max(0, this.pausedUntil - this.now());
    const deficit = this.tokens >= 1 ? 0 : ((1 - this.tokens) / this.perMin) * 60_000;
    return Math.max(pause, Math.ceil(deficit));
  }

  tryTake(): boolean {
    if (this.waitMs() > 0) return false;
    this.tokens -= 1;
    return true;
  }

  async take(): Promise<void> {
    for (;;) {
      const ms = this.waitMs();
      if (ms === 0) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}
