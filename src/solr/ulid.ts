import { randomBytes } from "node:crypto";

/**
 * A ULID (Crockford base32: 48 bits of milliseconds, 80 random), each
 * document's `uid`. Monotonic within a process: two minted in the same
 * millisecond sort in the order they were minted.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = -1;
let lastRandom: number[] = [];

export function ulid(now = Date.now()): string {
  if (now <= lastTime) {
    lastRandom = increment(lastRandom);
    now = lastTime;
  } else {
    lastTime = now;
    lastRandom = [...randomBytes(16)].map((byte) => byte % 32);
  }
  let time = "";
  let rest = now;
  for (let index = 0; index < 10; index += 1) {
    time = ALPHABET[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  return time + lastRandom.map((digit) => ALPHABET[digit]).join("");
}

function increment(digits: number[]): number[] {
  const next = [...digits];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const digit = (next[index] ?? 0) + 1;
    if (digit < 32) {
      next[index] = digit;
      return next;
    }
    next[index] = 0;
  }
  throw new Error("ULID random part overflowed within one millisecond.");
}
