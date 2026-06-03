import { add, double } from "../src/math.mjs";
let passed = 0, failed = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  × test/math.test.mjs > ${name}`); console.log(`    expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`); }
}
check("add sums two numbers", add(2, 3), 5);
check("double doubles", double(4), 8);
console.log("");
console.log(`Tests  ${failed} failed | ${passed} passed (${passed + failed})`);
if (failed > 0) process.exit(1);
