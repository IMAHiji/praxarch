import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../../test-support/dist-dir.js";

const { praxarchHome } = (await import(join(TEST_DIST_DIR, "hooks", "lib", "paths.js"))) as typeof import("./paths.js");

// Pins the `||` in praxarchHome: an empty PRAXARCH_HOME must fall back to the default home, never
// resolve stateDir() to the relative path "state" — the retention sweep (cli/prune.ts) deletes
// from that path, so the empty-string case turning relative would delete files from the cwd.
test("praxarchHome treats an empty PRAXARCH_HOME as unset", () => {
  const saved = process.env["PRAXARCH_HOME"];
  try {
    process.env["PRAXARCH_HOME"] = "";
    assert.equal(praxarchHome(), join(homedir(), ".claude", "praxarch"));
  } finally {
    if (saved === undefined) delete process.env["PRAXARCH_HOME"];
    else process.env["PRAXARCH_HOME"] = saved;
  }
});
