import { makeId } from "../src/id.mjs";
import { slugify } from "../src/slug.mjs";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  × test/id.test.mjs > ${name}`);
    console.log(`    expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  }
}

check("slugify lowercases and dashes", slugify("Hello World"), "hello-world");
check("slugify trims surrounding whitespace", slugify("  Hello World  "), "hello-world");
check("makeId composes a clean slug", makeId("  My Post ", 7), "my-post-7");

console.log("");
console.log(`Tests  ${failed} failed | ${passed} passed (${passed + failed})`);
if (failed > 0) process.exit(1);
