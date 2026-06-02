// Low-level helper. The bug lives here, but the failing test exercises it through src/id.mjs,
// so localizing it requires following the import edge, not just reading the spec's sibling.

export function slugify(text) {
  // BUG: leading/trailing whitespace is not trimmed, so " Hello World " becomes
  // "-hello-world-" instead of "hello-world".
  return text.toLowerCase().replace(/\s+/g, "-");
}
