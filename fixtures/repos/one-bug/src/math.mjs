// A tiny math helper with one obvious bug.
export function add(a, b) {
  // BUG: this subtracts instead of adding.
  return a - b;
}

export function double(x) {
  return x * 2;
}
