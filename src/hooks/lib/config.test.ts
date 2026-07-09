import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Imports the compiled output, not the sibling .ts source: this test relies on paths.ts reading
// process.env lazily per-call, and mutating process.env between in-process test cases only works
// against a real module graph that's been resolved the way Node.js resolves it at runtime.
const here = dirname(fileURLToPath(import.meta.url));
const { loadConfig, DEFAULT_CONFIG } = (await import(
  join(here, "..", "..", "..", "dist", "hooks", "lib", "config.js")
)) as typeof import("./config.js");

test("returns defaults when no global or project config exists", async () => {
  const home = await mkdtemp(join(tmpdir(), "praxarch-config-"));
  const cwd = await mkdtemp(join(tmpdir(), "praxarch-config-cwd-"));
  const prevHome = process.env["PRAXARCH_HOME"];
  process.env["PRAXARCH_HOME"] = home;
  try {
    const config = await loadConfig(cwd);
    assert.deepEqual(config, DEFAULT_CONFIG);
  } finally {
    if (prevHome === undefined) delete process.env["PRAXARCH_HOME"];
    else process.env["PRAXARCH_HOME"] = prevHome;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("project config overrides global config which overrides defaults", async () => {
  const home = await mkdtemp(join(tmpdir(), "praxarch-config-"));
  const cwd = await mkdtemp(join(tmpdir(), "praxarch-config-cwd-"));
  const prevHome = process.env["PRAXARCH_HOME"];
  process.env["PRAXARCH_HOME"] = home;
  try {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ verifyGate: { minChangedLines: 40 }, routeGuard: { strict: false } }),
    );
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "praxarch.json"),
      JSON.stringify({ verifyGate: { minChangedLines: 10 } }),
    );

    const config = await loadConfig(cwd);
    // project wins over global for the key both set
    assert.equal(config.verifyGate.minChangedLines, 10);
    // global value not overridden by project persists
    assert.equal(config.routeGuard.strict, false);
    // untouched defaults persist
    assert.equal(config.verifyGate.minChangedFiles, DEFAULT_CONFIG.verifyGate.minChangedFiles);
  } finally {
    if (prevHome === undefined) delete process.env["PRAXARCH_HOME"];
    else process.env["PRAXARCH_HOME"] = prevHome;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("securityKeywords from project config are additive, not replacing the built-in merge base", async () => {
  const home = await mkdtemp(join(tmpdir(), "praxarch-config-"));
  const cwd = await mkdtemp(join(tmpdir(), "praxarch-config-cwd-"));
  const prevHome = process.env["PRAXARCH_HOME"];
  process.env["PRAXARCH_HOME"] = home;
  try {
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "praxarch.json"),
      JSON.stringify({ routeGuard: { securityKeywords: ["billing-ledger"] } }),
    );
    const config = await loadConfig(cwd);
    assert.deepEqual(config.routeGuard.securityKeywords, ["billing-ledger"]);
  } finally {
    if (prevHome === undefined) delete process.env["PRAXARCH_HOME"];
    else process.env["PRAXARCH_HOME"] = prevHome;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
