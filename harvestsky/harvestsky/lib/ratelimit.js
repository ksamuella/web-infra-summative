'use strict';

/** Fixed-window rate limiter keyed by a string (usually the client IP). */
class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** Records a hit; returns true when the caller is over the limit. */
  hit(key, now = Date.now()) {
    if (this.hits.size > 10000) {
      for (const [k, v] of this.hits) if (now > v.resetAt) this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (!entry || now > entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return false;
    }
    entry.count += 1;
    return entry.count > this.max;
  }
}

module.exports = { RateLimiter };
