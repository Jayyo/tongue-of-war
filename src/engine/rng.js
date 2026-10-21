// Deterministic PRNG (mulberry32) — the whole sim must be reproducible from a seed
// so that balance tests and replays give identical results.
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const fn = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  fn.range = (lo, hi) => lo + fn() * (hi - lo);
  fn.int = (lo, hi) => Math.floor(fn.range(lo, hi + 1));
  fn.pick = (arr) => arr[Math.floor(fn() * arr.length)];
  return fn;
}

// Stable 32-bit hash of a string — used to seed unit generation from a prompt,
// so the same prompt always yields the same unit (Infinite Craft-style determinism).
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
