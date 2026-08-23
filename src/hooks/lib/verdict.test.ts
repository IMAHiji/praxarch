import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../../test-support/dist-dir.js";

// Imports the compiled output, not the sibling .ts source — matches the convention in
// measurement-cwd.test.ts: tests resolve modules the way Node does at runtime.
const { summarizeVerdict } = (await import(
  join(TEST_DIST_DIR, "hooks", "lib", "verdict.js")
)) as typeof import("./verdict.js");

test("lowercase critical still counts", () => {
  const result = summarizeVerdict({ verdict: "CONFIRMED", findings: [{ severity: "critical" }] });
  assert.equal(result.criticalOrMajorCount, 1);
});

test("capitalised severities count (case-insensitive)", () => {
  const result = summarizeVerdict({
    verdict: "CONFIRMED",
    findings: [{ severity: "Critical" }, { severity: "MAJOR" }],
  });
  assert.equal(result.criticalOrMajorCount, 2);
});

test("an unknown severity counts as major (fail closed)", () => {
  const result = summarizeVerdict({ verdict: "CONFIRMED", findings: [{ severity: "blocker" }] });
  assert.equal(result.criticalOrMajorCount, 1);
});

test("a missing severity counts", () => {
  const result = summarizeVerdict({ verdict: "CONFIRMED", findings: [{}] });
  assert.equal(result.criticalOrMajorCount, 1);
});

test("minor does not count, in any casing or with surrounding whitespace", () => {
  const result = summarizeVerdict({
    verdict: "CONFIRMED",
    findings: [{ severity: "minor" }, { severity: "Minor" }, { severity: " MINOR " }],
  });
  assert.equal(result.criticalOrMajorCount, 0);
  assert.equal(result.findingsCount, 3);
});

test("an empty findings array is zero", () => {
  const result = summarizeVerdict({ verdict: "CONFIRMED", findings: [] });
  assert.equal(result.criticalOrMajorCount, 0);
  assert.equal(result.findingsCount, 0);
});
