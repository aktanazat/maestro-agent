// A tiny statistics module. Two functions contain seeded bugs that the test suite catches.

export function mean(xs) {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  // BUG: for an even-length array the median is the average of the two middle values,
  // but this returns only the upper-middle element.
  return s[mid];
}

export function lastN(xs, n) {
  // BUG: off-by-one — this keeps one element too many.
  return xs.slice(xs.length - n - 1);
}

export function variance(xs) {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
}
