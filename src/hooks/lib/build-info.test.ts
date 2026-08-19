import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../../test-support/dist-dir.js";

// Imports the compiled output, not the sibling .ts source — matches the convention in
// config.test.ts.
const { readBuildInfo, formatBuildRef } = (await import(
  join(TEST_DIST_DIR, "hooks", "lib", "build-info.js")
)) as typeof import("./build-info.js");

async function withTempHooksDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "praxarch-build-info-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeBuildInfo(dir: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "build-info.json"), content, "utf8");
}

test("readBuildInfo returns all nulls when build-info.json is missing", async () => {
  await withTempHooksDir(async (dir) => {
    const info = await readBuildInfo(dir);
    assert.deepEqual(info, { ref: null, branch: null, dirty: null, builtAt: null });
    assert.equal(formatBuildRef(info), null);
  });
});

test("readBuildInfo degrades to nulls, not a throw, on corrupt JSON", async () => {
  await withTempHooksDir(async (dir) => {
    await writeBuildInfo(dir, "not json {{{");
    const info = await readBuildInfo(dir);
    assert.deepEqual(info, { ref: null, branch: null, dirty: null, builtAt: null });
    assert.equal(formatBuildRef(info), null);
  });
});

test("readBuildInfo ignores fields of the wrong type rather than propagating them", async () => {
  await withTempHooksDir(async (dir) => {
    await writeBuildInfo(dir, JSON.stringify({ ref: 12345, branch: true, dirty: "yes", builtAt: null }));
    const info = await readBuildInfo(dir);
    assert.deepEqual(info, { ref: null, branch: null, dirty: null, builtAt: null });
  });
});

test("formatBuildRef renders branch@shortref for a clean build on a named branch", async () => {
  await withTempHooksDir(async (dir) => {
    await writeBuildInfo(
      dir,
      JSON.stringify({
        ref: "574555d956c4d7aef027aadfe2cdb2db683f14c3",
        branch: "feat/record-verdict-cli",
        dirty: false,
        builtAt: "2026-08-19T00:00:00.000Z",
      }),
    );
    const info = await readBuildInfo(dir);
    assert.equal(formatBuildRef(info), "feat/record-verdict-cli@574555d956c4");
  });
});

test("formatBuildRef appends a dirty marker for a build with uncommitted changes", async () => {
  await withTempHooksDir(async (dir) => {
    await writeBuildInfo(
      dir,
      JSON.stringify({
        ref: "574555d956c4d7aef027aadfe2cdb2db683f14c3",
        branch: "main",
        dirty: true,
        builtAt: "2026-08-19T00:00:00.000Z",
      }),
    );
    const info = await readBuildInfo(dir);
    assert.equal(formatBuildRef(info), "main@574555d956c4 (dirty)");
  });
});

test("formatBuildRef falls back to the bare short ref when the branch is unknown (detached HEAD)", async () => {
  await withTempHooksDir(async (dir) => {
    await writeBuildInfo(
      dir,
      JSON.stringify({
        ref: "574555d956c4d7aef027aadfe2cdb2db683f14c3",
        branch: null,
        dirty: false,
        builtAt: "2026-08-19T00:00:00.000Z",
      }),
    );
    const info = await readBuildInfo(dir);
    assert.equal(formatBuildRef(info), "574555d956c4");
  });
});
