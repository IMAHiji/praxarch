import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../../test-support/dist-dir.js";
// Imports the compiled output, not the sibling .ts source — matches the convention in
// config.test.ts.
const { readJsonIfExists } = (await import(
  join(TEST_DIST_DIR, "cli", "lib", "fsops.js")
)) as typeof import("./fsops.js");

test("readJsonIfExists reports absent for a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "praxarch-fsops-"));
  try {
    const result = await readJsonIfExists(join(dir, "does-not-exist.json"));
    assert.deepEqual(result, { status: "absent" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readJsonIfExists reports ok with the parsed value for well-formed JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "praxarch-fsops-"));
  try {
    const path = join(dir, "valid.json");
    await writeFile(path, JSON.stringify({ hello: "world" }));
    const result = await readJsonIfExists<{ hello: string }>(path);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.status === "ok" ? result.value : null, { hello: "world" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readJsonIfExists reports malformed (never throws) for invalid JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "praxarch-fsops-"));
  try {
    const path = join(dir, "malformed.json");
    await writeFile(path, "not json {{{");
    const result = await readJsonIfExists(path);
    assert.equal(result.status, "malformed");
    assert.ok(result.status === "malformed" && result.error instanceof Error);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
