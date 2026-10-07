import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../../test-support/dist-dir.js";

// Imports the compiled output, not the sibling .ts source — matches the convention in
// verdict.test.ts: tests resolve modules the way Node does at runtime.
const { TIER_ORDER, tierOf } = (await import(
  join(TEST_DIST_DIR, "hooks", "lib", "tiers.js")
)) as typeof import("./tiers.js");

test("tier order is haiku < sonnet < opus < fable", () => {
  assert.deepEqual([...TIER_ORDER], ["haiku", "sonnet", "opus", "fable"]);
});

test("tierOf identifies short tier names", () => {
  for (const tier of TIER_ORDER) assert.equal(tierOf(tier), tier);
});

test("tierOf identifies full model ids, including context-window suffixes", () => {
  assert.equal(tierOf("claude-opus-5-5"), "opus");
  assert.equal(tierOf("claude-opus-4-8[1m]"), "opus");
  assert.equal(tierOf("claude-fable-5-1"), "fable");
  assert.equal(tierOf("claude-fable-5-1[1m]"), "fable");
  assert.equal(tierOf("claude-sonnet-5"), "sonnet");
  assert.equal(tierOf("claude-haiku-5-5"), "haiku");
});

test("tierOf is case-insensitive", () => {
  assert.equal(tierOf("Fable"), "fable");
  assert.equal(tierOf("CLAUDE-OPUS-5-5"), "opus");
});

test("tierOf returns null for unknown models and non-strings, without throwing", () => {
  for (const model of ["", "inherit", "gpt-5", undefined, null, 123, true, ["opus"], { model: "opus" }]) {
    assert.equal(tierOf(model), null, `model: ${JSON.stringify(model)}`);
  }
});

test("tierOf resolves an id naming two tiers to the lower one", () => {
  assert.equal(tierOf("haiku-opus"), "haiku");
  assert.equal(tierOf("fable-sonnet"), "sonnet");
});
