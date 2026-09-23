import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../../test-support/dist-dir.js";

// Imports the compiled output, not the sibling .ts source — matches the convention in
// measurement-cwd.test.ts: tests resolve modules the way Node does at runtime.
const { summarizeVerdict, MalformedVerdictError } = (await import(
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

test("issue #3: a missing scope reads as session", () => {
  assert.equal(summarizeVerdict({ verdict: "CONFIRMED" }).scope, "session");
});

test("issue #3: session and branch:<name> scopes pass through verbatim", () => {
  for (const scope of ["session", "branch:feat/login-fix", "branch:feat/caf\u00e9", `branch:${"x".repeat(255)}`]) {
    assert.equal(summarizeVerdict({ verdict: "CONFIRMED", scope }).scope, scope);
  }
});

test("issue #3: an unknown or malformed scope is a malformed verdict", () => {
  for (const scope of [
    "Session",
    "worktree",
    "branch:",
    "branch:has space",
    "branch:a\nb",
    `branch:${"x".repeat(256)}`,
    // C0/C1 controls and Cf format characters: ESC (terminal escapes), RLO, zero-width space, NUL, DEL.
    "branch:a\u001b[31m",
    "branch:a\u202eb",
    "branch:a\u200bb",
    "branch:a\u0000",
    "branch:a\u007f",
    null,
    42,
    ["session"],
  ]) {
    assert.throws(() => summarizeVerdict({ verdict: "CONFIRMED", scope }), MalformedVerdictError, JSON.stringify(scope));
  }
});

test("issue #3: a malformed scope's error message is bounded", () => {
  const scope = `branch:${"x".repeat(9993)}`;
  assert.equal(scope.length, 10000);
  assert.throws(
    () => summarizeVerdict({ verdict: "CONFIRMED", scope }),
    (err: unknown) => err instanceof MalformedVerdictError && err.message.length < 200,
  );
});
