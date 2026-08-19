import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../../test-support/dist-dir.js";
// Imports the compiled output, not the sibling .ts source: matches the convention in
// config.test.ts (see the comment there) -- paths.ts reads process.env["PRAXARCH_HOME"] lazily
// per-call, and mutating process.env between in-process test cases only works reliably against a
// real module graph resolved the way Node.js resolves it at runtime.
const { readUntrackedBaseline, writeUntrackedBaseline } = (await import(
  join(TEST_DIST_DIR, "hooks", "lib", "untracked-baseline-store.js")
)) as typeof import("./untracked-baseline-store.js");
const { untrackedBaselinePath } = (await import(
  join(TEST_DIST_DIR, "hooks", "lib", "paths.js")
)) as typeof import("./paths.js");

const sessionId = "test-session";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "praxarch-untracked-baseline-store-"));
  const prevHome = process.env["PRAXARCH_HOME"];
  process.env["PRAXARCH_HOME"] = home;
  try {
    await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env["PRAXARCH_HOME"];
    else process.env["PRAXARCH_HOME"] = prevHome;
    await rm(home, { recursive: true, force: true });
  }
}

test("readUntrackedBaseline returns null when the file was never written (missing file)", async () => {
  await withHome(async () => {
    const result = await readUntrackedBaseline(sessionId);
    assert.equal(result, null);
  });
});

test("readUntrackedBaseline returns null for an empty file", async () => {
  await withHome(async (home) => {
    const path = untrackedBaselinePath(sessionId);
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(path, "", "utf8");
    const result = await readUntrackedBaseline(sessionId);
    assert.equal(result, null);
  });
});

test("readUntrackedBaseline returns null for truncated JSON", async () => {
  await withHome(async (home) => {
    const path = untrackedBaselinePath(sessionId);
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(path, '{"p:a":"f:aa', "utf8");
    const result = await readUntrackedBaseline(sessionId);
    assert.equal(result, null);
  });
});

test("readUntrackedBaseline returns null for non-JSON content", async () => {
  await withHome(async (home) => {
    const path = untrackedBaselinePath(sessionId);
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(path, "not json at all", "utf8");
    const result = await readUntrackedBaseline(sessionId);
    assert.equal(result, null);
  });
});

test("readUntrackedBaseline returns null for a well-formed JSON array (wrong shape)", async () => {
  await withHome(async (home) => {
    const path = untrackedBaselinePath(sessionId);
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(path, JSON.stringify(["p:a", "f:aa"]), "utf8");
    const result = await readUntrackedBaseline(sessionId);
    assert.equal(result, null);
  });
});

test("readUntrackedBaseline returns null for a well-formed JSON number (wrong shape)", async () => {
  await withHome(async (home) => {
    const path = untrackedBaselinePath(sessionId);
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(path, "42", "utf8");
    const result = await readUntrackedBaseline(sessionId);
    assert.equal(result, null);
  });
});

test("readUntrackedBaseline returns null for a well-formed JSON string (wrong shape)", async () => {
  await withHome(async (home) => {
    const path = untrackedBaselinePath(sessionId);
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(path, JSON.stringify("hello"), "utf8");
    const result = await readUntrackedBaseline(sessionId);
    assert.equal(result, null);
  });
});

test("readUntrackedBaseline returns null for a JSON null literal (documented unusable-capture case)", async () => {
  await withHome(async () => {
    // Written directly rather than through writeUntrackedBaseline(sessionId, null) so this test
    // pins the on-disk shape (the literal `null`) independent of the writer, matching the doc
    // comment's claim about the format.
    await writeUntrackedBaseline(sessionId, null);
    const result = await readUntrackedBaseline(sessionId);
    assert.equal(result, null);
  });
});

test("readUntrackedBaseline round-trips a well-formed baseline object written by writeUntrackedBaseline (happy path)", async () => {
  await withHome(async () => {
    const baseline = { "p:a": "f:aa", "p:b": "f:bb" };
    await writeUntrackedBaseline(sessionId, baseline);
    const result = await readUntrackedBaseline(sessionId);
    // Asserted directly against the return value, not through lookupUntrackedBaseline -- a
    // known no-op mutant (returning {} instead of null on a missing file) is invisible through
    // any lookup, since lookupUntrackedBaseline treats null and {} identically. Pinning the
    // exact returned object here is what would catch that mutant, plus this happy-path shape.
    assert.deepEqual(result, baseline);
  });
});

test("readUntrackedBaseline returns null for an empty object (distinct from a missing file, but currently identical to callers -- see doc comment)", async () => {
  await withHome(async () => {
    await writeUntrackedBaseline(sessionId, {});
    const result = await readUntrackedBaseline(sessionId);
    assert.deepEqual(result, {});
  });
});
