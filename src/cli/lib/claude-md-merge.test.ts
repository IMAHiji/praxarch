import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../../test-support/dist-dir.js";
const { upsertOrchestrationBlock } = (await import(
  join(TEST_DIST_DIR, "cli", "lib", "claude-md-merge.js")
)) as typeof import("./claude-md-merge.js");

const START = "<!-- praxarch:orchestration:start -->";
const END = "<!-- praxarch:orchestration:end -->";
const BLOCK = `${START}\nnew policy\n${END}\n`;

test("no markers: inserts the block", () => {
  const existing = "# Mine\n";
  const result = upsertOrchestrationBlock(existing, BLOCK);
  assert.equal(result.action, "inserted");
  assert.equal(result.changed, true);
  assert.equal(result.content, `# Mine\n\n${BLOCK}`);
});

test("valid pair with identical content: unchanged", () => {
  const existing = `# Mine\n\n${BLOCK}`;
  const result = upsertOrchestrationBlock(existing, BLOCK);
  assert.deepEqual(result, { content: existing, changed: false, action: "unchanged" });
});

test("valid pair with different content: updated in place", () => {
  const existing = `# Mine\n\n${START}\nold policy\n${END}\n# Tail\n`;
  const result = upsertOrchestrationBlock(existing, BLOCK);
  assert.equal(result.action, "updated");
  assert.equal(result.changed, true);
  assert.equal(result.content, `# Mine\n\n${BLOCK}\n# Tail\n`);
});

test("start marker without end: skipped, content untouched", () => {
  const existing = `# Mine\n\n${START}\nhand-condensed policy\n`;
  const result = upsertOrchestrationBlock(existing, BLOCK);
  assert.deepEqual(result, { content: existing, changed: false, action: "skipped-unpaired-markers" });
});

test("end marker without start: skipped, content untouched", () => {
  const existing = `# Mine\n\nhand-condensed policy\n${END}\n`;
  const result = upsertOrchestrationBlock(existing, BLOCK);
  assert.deepEqual(result, { content: existing, changed: false, action: "skipped-unpaired-markers" });
});

test("end marker before start marker: skipped, content untouched", () => {
  const existing = `# Mine\n${END}\nmiddle\n${START}\n`;
  const result = upsertOrchestrationBlock(existing, BLOCK);
  assert.deepEqual(result, { content: existing, changed: false, action: "skipped-unpaired-markers" });
});
