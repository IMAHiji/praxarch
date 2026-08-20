import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DIST_DIR } from "../test-support/dist-dir.js";

const cli = join(TEST_DIST_DIR, "cli", "index.js");
const verifyGateScript = join(TEST_DIST_DIR, "hooks", "verify-gate.js");

interface Fixture {
  repo: string;
  home: string;
}

async function setupFixture(): Promise<Fixture> {
  const repo = await mkdtemp(join(tmpdir(), "praxarch-record-verdict-repo-"));
  const home = await mkdtemp(join(tmpdir(), "praxarch-record-verdict-home-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "file.txt"), "line\n".repeat(5));
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  return { repo, home };
}

async function teardownFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.repo, { recursive: true, force: true });
  await rm(fixture.home, { recursive: true, force: true });
}

function runRecordVerdict(
  fixture: Fixture,
  args: string[],
  input: string,
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  // spawnSync (not execFileSync) so stderr is captured on the success path too — record-verdict
  // can exit 0 while still writing a warning to stderr (e.g. a failed delegation-log append).
  const result = spawnSync("node", [cli, "record-verdict", ...args], {
    cwd: fixture.repo,
    input,
    env: { ...process.env, PRAXARCH_HOME: fixture.home, ...extraEnv },
  });
  return {
    stdout: result.stdout?.toString("utf8") ?? "",
    stderr: result.stderr?.toString("utf8") ?? "",
    status: result.status ?? 1,
  };
}

function runVerifyGate(fixture: Fixture, sessionId: string): { decision?: string; reason?: string } {
  const stdout = execFileSync("node", [verifyGateScript], {
    cwd: fixture.repo,
    input: JSON.stringify({ session_id: sessionId, cwd: fixture.repo, hook_event_name: "Stop" }),
    env: { ...process.env, PRAXARCH_HOME: fixture.home },
  }).toString("utf8");
  return JSON.parse(stdout) as { decision?: string; reason?: string };
}

function readState(home: string, sessionId: string): Promise<Record<string, unknown>> {
  return readFile(join(home, "state", `${sessionId}.json`), "utf8").then(
    (raw) => JSON.parse(raw) as Record<string, unknown>,
  );
}

async function stateExists(home: string, sessionId: string): Promise<boolean> {
  try {
    await readFile(join(home, "state", `${sessionId}.json`), "utf8");
    return true;
  } catch {
    return false;
  }
}

async function readMonthlyLog(home: string): Promise<Record<string, unknown>[]> {
  const now = new Date();
  const path = join(home, "logs", `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function verifierText(verdict: "CONFIRMED" | "REFUTED", findings: { severity: string }[] = []): string {
  return [
    "Some prose the resumed agent wrote before its verdict.",
    "```json",
    JSON.stringify({ verdict, findings }),
    "```",
  ].join("\n");
}

// Acceptance criterion 1: a fixture verifier output records lastVerifier with correct
// verdict/counts/fingerprint, and a subsequent verify-gate run against the unchanged tree passes.
test("records a verdict and verify-gate then allows the unchanged tree", async () => {
  const fixture = await setupFixture();
  try {
    await writeFile(join(fixture.repo, "file.txt"), "changed line\n".repeat(100));

    const result = runRecordVerdict(fixture, ["--session", "s1", "--role", "verifier"], verifierText("CONFIRMED"));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CONFIRMED/);

    const state = await readState(fixture.home, "s1");
    const lastVerifier = state["lastVerifier"] as {
      verdict: string;
      diffHash: string | null;
      changedLines: number | null;
      changedFiles: number | null;
      findingsCount: number;
      criticalOrMajorCount: number;
    };
    assert.equal(lastVerifier.verdict, "CONFIRMED");
    assert.equal(lastVerifier.findingsCount, 0);
    assert.equal(lastVerifier.criticalOrMajorCount, 0);
    assert.equal(typeof lastVerifier.diffHash, "string");
    assert.equal(lastVerifier.changedLines, 105);
    assert.equal(lastVerifier.changedFiles, 1);

    const gate = runVerifyGate(fixture, "s1");
    assert.equal(gate.decision, undefined, JSON.stringify(gate));
  } finally {
    await teardownFixture(fixture);
  }
});

// Acceptance criterion 6, simulated: a resumed agent's SendMessage reply is invisible to
// telemetry.ts (it only fires on PostToolUse(Agent) — see telemetry.ts:55), so the orchestrator is
// expected to pipe that reply through `praxarch record-verdict` instead. This test drives the CLI
// exactly the way that hand-off would: REFUTED verdict recorded on the pre-fix tree (verify-gate
// blocks), a fix changes the tree, then a second `record-verdict` call for the same session/role
// records CONFIRMED — standing in for the resumed verifier's reply — and verify-gate must pass on
// the new tree state with no `PRAXARCH_VERIFY_WAIVED` waiver anywhere in this test.
test("REFUTED then a fix then CONFIRMED via record-verdict (simulated resumed-agent flow) clears verify-gate with no waiver", async () => {
  const fixture = await setupFixture();
  try {
    await writeFile(join(fixture.repo, "file.txt"), "changed line\n".repeat(100));

    const refuted = runRecordVerdict(
      fixture,
      ["--session", "s15", "--role", "verifier"],
      verifierText("REFUTED", [{ severity: "critical" }]),
    );
    assert.equal(refuted.status, 0, refuted.stderr);

    const blockedGate = runVerifyGate(fixture, "s15");
    assert.equal(blockedGate.decision, "block", JSON.stringify(blockedGate));

    // The fix: further tree movement, standing in for the orchestrator addressing the REFUTED
    // findings before re-dispatching (resuming) the verifier.
    await writeFile(join(fixture.repo, "file.txt"), "fixed line\n".repeat(120));

    const confirmed = runRecordVerdict(
      fixture,
      ["--session", "s15", "--role", "verifier"],
      verifierText("CONFIRMED"),
    );
    assert.equal(confirmed.status, 0, confirmed.stderr);

    const state = await readState(fixture.home, "s15");
    assert.equal((state["lastVerifier"] as { verdict: string }).verdict, "CONFIRMED");

    const passingGate = runVerifyGate(fixture, "s15");
    assert.equal(passingGate.decision, undefined, JSON.stringify(passingGate));
  } finally {
    await teardownFixture(fixture);
  }
});

// Acceptance criterion 2: a role outside verdictRoles is refused, non-zero exit, state untouched.
test("refuses a role outside verdictRoles and leaves state untouched", async () => {
  const fixture = await setupFixture();
  try {
    const result = runRecordVerdict(fixture, ["--session", "s2", "--role", "scout"], verifierText("CONFIRMED"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not in verdictRoles/);
    assert.equal(await stateExists(fixture.home, "s2"), false);
  } finally {
    await teardownFixture(fixture);
  }
});

// Acceptance criterion 3: input with no JSON verdict block is refused, non-zero exit, state
// untouched — an arbitrary blob of agent prose must never be laundered into a recorded verdict.
test("refuses input with no trailing JSON verdict block and leaves state untouched", async () => {
  const fixture = await setupFixture();
  try {
    const result = runRecordVerdict(
      fixture,
      ["--session", "s3", "--role", "verifier"],
      "Looks fine to me, no notes.",
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no trailing JSON verdict block/);
    assert.equal(await stateExists(fixture.home, "s3"), false);
  } finally {
    await teardownFixture(fixture);
  }
});

// Also covers the "malformed input" edge of criterion 3/decision 4: a fenced block that parses as
// JSON but carries no `verdict` key must not be treated as a verdict either.
test("refuses a fenced JSON block that has no verdict key", async () => {
  const fixture = await setupFixture();
  try {
    const text = ["```json", JSON.stringify({ findings: [] }), "```"].join("\n");
    const result = runRecordVerdict(fixture, ["--session", "s3b", "--role", "verifier"], text);
    assert.notEqual(result.status, 0);
    assert.equal(await stateExists(fixture.home, "s3b"), false);
  } finally {
    await teardownFixture(fixture);
  }
});

// Acceptance criterion 4, end-to-end: a fingerprint capture failure records diffHash: null (not a
// refusal), and verify-gate's present-but-null rule still denies a free pass on that record — it
// is not treated as a legacy (pre-fingerprint) record just because the key is null. Per
// verify-gate.ts, a null diffHash only loses its free pass once the delta versus the recorded
// (also-failed, so zero) counts clears the non-trivial threshold — which any non-trivial current
// diff does, since a totally failed measurement records changedLines/changedFiles as null too.
test("a fingerprint failure records diffHash: null and verify-gate still blocks (no free pass)", async () => {
  const fixture = await setupFixture();
  const fakeGitDir = await mkdtemp(join(tmpdir(), "praxarch-record-verdict-fakegit-"));
  try {
    await writeFile(join(fixture.repo, "file.txt"), "changed line\n".repeat(100));

    const realGit = execFileSync("which", ["git"]).toString("utf8").trim();
    // Fails BOTH `status` (diffFingerprint) and `--numstat` (diffStat's tracked-diff probe), so
    // the record comes back with diffHash, changedLines, and changedFiles all null — matching
    // verify-gate.test.ts's own "does NOT get the legacy free pass" fixture. Failing status alone
    // still lets --numstat succeed, which records real (non-null) counts and, with no further
    // tree movement after recording, legitimately allows on the next stop — that's a different,
    // already-covered case, not this one.
    const fakeGitScript = [
      "#!/bin/sh",
      'case "$*" in',
      `  *ls-files*) exec "${realGit}" "$@" ;;`,
      '  status*) echo "fake git: status failed" >&2; exit 1 ;;',
      '  diff*--numstat*) echo "fake git: numstat failed" >&2; exit 1 ;;',
      `  *) exec "${realGit}" "$@" ;;`,
      "esac",
    ].join("\n");
    await writeFile(join(fakeGitDir, "git"), `${fakeGitScript}\n`, "utf8");
    await chmod(join(fakeGitDir, "git"), 0o755);

    const result = runRecordVerdict(fixture, ["--session", "s4", "--role", "verifier"], verifierText("CONFIRMED"), {
      PATH: `${fakeGitDir}:${process.env["PATH"] ?? ""}`,
    });
    assert.equal(result.status, 0, result.stderr);

    const state = await readState(fixture.home, "s4");
    const lastVerifier = state["lastVerifier"] as {
      verdict: string;
      diffHash: string | null;
      changedLines: number | null;
      changedFiles: number | null;
    };
    assert.equal(lastVerifier.verdict, "CONFIRMED");
    assert.equal(lastVerifier.diffHash, null);
    assert.equal(lastVerifier.changedLines, null);
    assert.equal(lastVerifier.changedFiles, null);

    // verify-gate itself runs with the REAL git (fake git was only on PATH for the CLI call
    // above) — this is the live end-to-end check, not a unit assertion on the null alone.
    const gate = runVerifyGate(fixture, "s4");
    assert.equal(gate.decision, "block", JSON.stringify(gate));
    assert.match(gate.reason ?? "", /stale/);
  } finally {
    await teardownFixture(fixture);
    await rm(fakeGitDir, { recursive: true, force: true });
  }
});

// Acceptance criterion 5: the JSONL row carries the via marker and praxarch report counts it.
test("appends a delegation-log row marked via record-verdict, and praxarch report counts it", async () => {
  const fixture = await setupFixture();
  try {
    const result = runRecordVerdict(
      fixture,
      ["--session", "s5", "--role", "plan-reviewer"],
      verifierText("REFUTED", [{ severity: "major" }]),
    );
    assert.equal(result.status, 0, result.stderr);

    const rows = await readMonthlyLog(fixture.home);
    const row = rows.find((r) => r["sessionId"] === "s5");
    assert.ok(row, "expected a logged row for session s5");
    assert.equal(row?.["via"], "record-verdict");
    assert.equal(row?.["role"], "plan-reviewer");
    assert.equal(row?.["verdict"], "REFUTED");
    assert.equal(row?.["criticalOrMajorCount"], 1);
    assert.equal(row?.["findingsCount"], 1);

    const reportScript = join(TEST_DIST_DIR, "report", "report.js");
    const reportOut = execFileSync("node", [reportScript], {
      env: { ...process.env, PRAXARCH_HOME: fixture.home },
    }).toString("utf8");
    assert.match(reportOut, /plan-reviewer: 1/);
    assert.match(reportOut, /Verifier pass rate: 0\/1/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("requires --session and --role", async () => {
  const fixture = await setupFixture();
  try {
    const result = runRecordVerdict(fixture, ["--role", "verifier"], verifierText("CONFIRMED"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--session <id> and --role <role> are required/);
  } finally {
    await teardownFixture(fixture);
  }
});

// Regression: a `findings` value that isn't an array (or that contains a non-object entry) must
// be refused as malformed input, not coerced to an empty array and recorded as a verdict.
test("refuses a verdict block whose findings is not an array of objects", async () => {
  const fixture = await setupFixture();
  try {
    const text = ["```json", JSON.stringify({ verdict: "CONFIRMED", findings: "nope" }), "```"].join("\n");
    const result = runRecordVerdict(fixture, ["--session", "s7", "--role", "verifier"], text);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /malformed verdict block/);
    assert.equal(await stateExists(fixture.home, "s7"), false);
  } finally {
    await teardownFixture(fixture);
  }
});

test("refuses a verdict block whose findings array contains a non-object entry", async () => {
  const fixture = await setupFixture();
  try {
    const text = ["```json", JSON.stringify({ verdict: "CONFIRMED", findings: [null] }), "```"].join("\n");
    const result = runRecordVerdict(fixture, ["--session", "s7b", "--role", "verifier"], text);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /malformed verdict block/);
    assert.equal(await stateExists(fixture.home, "s7b"), false);
  } finally {
    await teardownFixture(fixture);
  }
});

// Regression: the verdict is already recorded in session state by the time the JSONL append
// runs — if that append fails (e.g. an unwritable log dir), the CLI must still report success and
// exit 0, with a note that the delegation-log row could not be written, rather than exiting 1 and
// leading an operator to conclude the verdict was never recorded.
test("reports success when the verdict is recorded but the delegation-log append fails", async () => {
  const fixture = await setupFixture();
  try {
    // Force appendJsonl's mkdir(dirname(path), { recursive: true }) to fail by pre-creating the
    // log directory's path as a plain file instead of a directory.
    await writeFile(join(fixture.home, "logs"), "not a directory");

    const result = runRecordVerdict(fixture, ["--session", "s8", "--role", "verifier"], verifierText("CONFIRMED"));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CONFIRMED/);
    assert.match(result.stderr, /delegation-log row could not be written/);

    const state = await readState(fixture.home, "s8");
    assert.equal((state["lastVerifier"] as { verdict: string }).verdict, "CONFIRMED");
  } finally {
    await teardownFixture(fixture);
  }
});

// Regression for the verdict-parser defect: a finding's failure_scenario quotes a fenced json
// example inside a JSON string value. The embedded literal "```json"/"```" characters sit inside
// the string, not as real fence syntax, so the real trailing block (which terminates the output)
// must still parse — not the truncated fragment a non-greedy regex would stop at.
test("parses the real trailing verdict when a finding embeds a fenced json example in a string", async () => {
  const fixture = await setupFixture();
  try {
    const text = [
      "Reviewed the change.",
      "```json",
      JSON.stringify({
        verdict: "CONFIRMED",
        findings: [
          {
            severity: "minor",
            failure_scenario:
              'Handlers that stop at the first fence, e.g. a verdict block like ```json\n{"verdict":"CONFIRMED"}\n``` embedded in a string, truncate.',
          },
        ],
      }),
      "```",
    ].join("\n");

    const result = runRecordVerdict(fixture, ["--session", "s9", "--role", "verifier"], text);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CONFIRMED/);

    const state = await readState(fixture.home, "s9");
    const lastVerifier = state["lastVerifier"] as { verdict: string; findingsCount: number };
    assert.equal(lastVerifier.verdict, "CONFIRMED");
    assert.equal(lastVerifier.findingsCount, 1);
  } finally {
    await teardownFixture(fixture);
  }
});

// An unrelated fenced json example earlier in the prose (not embedded inside the real verdict's
// own JSON) must not be picked up in place of the trailing verdict block. Both fenced blocks here
// terminate the text they precede (no prose ever follows a closing fence), so this pins the
// "prefer the opener closest to the terminating close" selection logic specifically — it does not
// exercise the separate "block must terminate the output" requirement; see the dedicated
// true-red test below for that.
test("returns the verdict from the last fenced json block before the terminating fence, not an earlier unrelated example", async () => {
  const fixture = await setupFixture();
  try {
    const text = [
      "For reference, here's what a REFUTED example looks like:",
      "```json",
      JSON.stringify({ verdict: "REFUTED", findings: [] }),
      "```",
      "That's not this run's result. Here is the actual verdict:",
      "```json",
      JSON.stringify({ verdict: "CONFIRMED", findings: [] }),
      "```",
    ].join("\n");

    const result = runRecordVerdict(fixture, ["--session", "s10", "--role", "verifier"], text);
    assert.equal(result.status, 0, result.stderr);

    const state = await readState(fixture.home, "s10");
    assert.equal((state["lastVerifier"] as { verdict: string }).verdict, "CONFIRMED");
  } finally {
    await teardownFixture(fixture);
  }
});

// Text with only an illustrative fenced json example (not at the end of the output — real prose
// follows it) must not be recordable as a verdict, even though it parses as valid JSON with a
// `verdict` key.
test("refuses text with only an illustrative fenced json example and no real trailing verdict", async () => {
  const fixture = await setupFixture();
  try {
    const text = [
      "A verdict block looks like this:",
      "```json",
      JSON.stringify({ verdict: "CONFIRMED", findings: [] }),
      "```",
      "But that's just an example — I haven't actually finished reviewing yet.",
    ].join("\n");

    const result = runRecordVerdict(fixture, ["--session", "s11", "--role", "verifier"], text);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no trailing JSON verdict block/);
    assert.equal(await stateExists(fixture.home, "s11"), false);
  } finally {
    await teardownFixture(fixture);
  }
});

test("reads the verdict from --file instead of stdin", async () => {
  const fixture = await setupFixture();
  try {
    const filePath = join(fixture.repo, "verdict.txt");
    await writeFile(filePath, verifierText("CONFIRMED"));
    const result = runRecordVerdict(fixture, ["--session", "s6", "--role", "verifier", "--file", filePath], "");
    assert.equal(result.status, 0, result.stderr);
    const state = await readState(fixture.home, "s6");
    assert.equal((state["lastVerifier"] as { verdict: string }).verdict, "CONFIRMED");
  } finally {
    await teardownFixture(fixture);
  }
});

// Pins the contract templates/agents/verifier.md and plan-reviewer.md now state explicitly: the
// fenced JSON verdict block must be the LAST thing in the output. A verdict block followed by any
// trailing prose (a closing remark, a sign-off — exactly what the un-tightened prompt used to
// illustrate) must be refused, not silently parsed. This is the exact input shape from the
// reproduction in the verifier's REFUTED finding.
test("refuses a verdict block followed by trailing prose, even a short sign-off", async () => {
  const fixture = await setupFixture();
  try {
    const text = ["prose", "```json", JSON.stringify({ verdict: "CONFIRMED", findings: [] }), "```", "", "That is all."].join(
      "\n",
    );

    const result = runRecordVerdict(fixture, ["--session", "s12", "--role", "verifier"], text);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no trailing JSON verdict block/);
    assert.equal(await stateExists(fixture.home, "s12"), false);
  } finally {
    await teardownFixture(fixture);
  }
});

// Fix 2: `verdict` must be constrained to "CONFIRMED"/"REFUTED" — anything else is malformed
// input refused via MalformedVerdictError, not silently recorded (and not allowed to overwrite a
// previously recorded good verdict).
test("refuses a verdict block with a value other than CONFIRMED/REFUTED", async () => {
  const fixture = await setupFixture();
  try {
    const good = runRecordVerdict(fixture, ["--session", "s13", "--role", "verifier"], verifierText("CONFIRMED"));
    assert.equal(good.status, 0, good.stderr);

    const text = ["```json", JSON.stringify({ verdict: "MAYBE", findings: [] }), "```"].join("\n");
    const result = runRecordVerdict(fixture, ["--session", "s13", "--role", "verifier"], text);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /malformed verdict block/);

    const state = await readState(fixture.home, "s13");
    assert.equal((state["lastVerifier"] as { verdict: string }).verdict, "CONFIRMED");
  } finally {
    await teardownFixture(fixture);
  }
});

// Fix 3: no --file and stdin is a TTY must exit immediately with a usage hint instead of hanging
// forever in readStdin's for-await loop. spawnSync always hands the child a pipe, never a real
// TTY, so this exercises `recordVerdict` in-process and forces `process.stdin.isTTY` to simulate
// an interactive terminal — the one condition that actually triggers the hang this fix prevents.
test("refuses immediately (no hang) when --file is omitted and stdin is a TTY", async () => {
  const fixture = await setupFixture();
  const stdin = process.stdin as unknown as { isTTY?: boolean };
  const originalIsTTY = stdin.isTTY;
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalHome = process.env["PRAXARCH_HOME"];
  let stderrOutput = "";
  try {
    stdin.isTTY = true;
    process.env["PRAXARCH_HOME"] = fixture.home;
    process.stderr.write = ((chunk: string) => {
      stderrOutput += chunk;
      return true;
    }) as typeof process.stderr.write;

    const { recordVerdict } = (await import(cli.replace(/index\.js$/, "record-verdict.js"))) as {
      recordVerdict: (argv: string[], cwd?: string) => Promise<number>;
    };
    const status = await recordVerdict(["--session", "s14", "--role", "verifier"], fixture.repo);

    assert.notEqual(status, 0);
    assert.match(stderrOutput, /stdin is a TTY|--file/);
    assert.equal(await stateExists(fixture.home, "s14"), false);
  } finally {
    if (originalIsTTY === undefined) delete stdin.isTTY;
    else stdin.isTTY = originalIsTTY;
    process.stderr.write = originalWrite;
    if (originalHome === undefined) delete process.env["PRAXARCH_HOME"];
    else process.env["PRAXARCH_HOME"] = originalHome;
    await teardownFixture(fixture);
  }
});
