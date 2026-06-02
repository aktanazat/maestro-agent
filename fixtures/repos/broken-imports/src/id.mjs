import { slugify } from "./slug.mjs";

// This module is correct. It just composes the buggy helper, so the failure surfaces here
// while the fix belongs one import away in slug.mjs.
export function makeId(title, n) {
  return `${slugify(title)}-${n}`;
}
