// Zero-dependency test runner. Emits vitest-style lines so maestro's shell.run_tests parser
// can structure the results, and exits non-zero when any case fails.
import { mean, median, lastN, variance } from "../src/stats.mjs";

let passed = 0;
let failed = 0;
const fails = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    fails.push(name);
    console.log(`  × test/stats.test.mjs > ${name}`);
    console.log(`    expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  }
}

check("mean averages values", mean([2, 4, 6]), 4);
check("median odd-length returns middle", median([3, 1, 2]), 2);
check("median even-length averages two middles", median([1, 2, 3, 4]), 2.5);
check("lastN returns exactly n elements", lastN([1, 2, 3, 4, 5], 2), [4, 5]);
check("variance of constant is zero", variance([5, 5, 5]), 0);

console.log("");
console.log(`Tests  ${failed} failed | ${passed} passed (${passed + failed})`);
if (failed > 0) {
  console.log(`Failures: ${fails.join(", ")}`);
  process.exit(1);
}
