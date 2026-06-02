import { pageCount, pageSlice, hasNextPage } from "../src/paginate.mjs";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  × test/paginate.test.mjs > ${name}`);
    console.log(`    expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  }
}

const items = [1, 2, 3, 4, 5, 6];
check("pageCount rounds up a partial last page", pageCount(10, 3), 4);
check("pageCount is exact when evenly divisible", pageCount(6, 3), 2);
check("pageSlice returns the first page (1-indexed)", pageSlice(items, 1, 2), [1, 2]);
check("pageSlice returns the second page", pageSlice(items, 2, 2), [3, 4]);
check("hasNextPage is false on the last page", hasNextPage(6, 2, 3), false);

console.log("");
console.log(`Tests  ${failed} failed | ${passed} passed (${passed + failed})`);
if (failed > 0) process.exit(1);
