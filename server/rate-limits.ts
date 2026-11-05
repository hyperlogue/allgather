import { AppError } from "../shared/contracts.ts";

export class RateLimits {
  private entries = new Map<string, { count: number; until: number }>();
  constructor(
    private capacity = 10000,
    private clock = Date.now,
  ) {}
  take(key: string, maximum: number) {
    const now = this.clock();
    let entry = this.entries.get(key);
    this.entries.delete(key);
    if (!entry || entry.until <= now) entry = { count: 0, until: now + 60000 };
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, entry);
    if (entry.count >= maximum)
      throw new AppError("rate_limited", "Too many requests. Try again shortly.", 429, {
        retry_after: Math.ceil((entry.until - now) / 1000),
      });
    entry.count++;
  }
}
