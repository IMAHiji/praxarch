import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { TEST_DIST_DIR } from "../test-support/dist-dir.js";

const cli = join(TEST_DIST_DIR, "cli", "index.js");

interface Fixture {
  repo: string;
}

async function setupFixture(): Promise<Fixture> {
  const repo = await mkdtemp(join(tmpdir(), "praxarch-verify-bundle-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "tracked.txt"), "line one\nline two\n");
  await writeFile(join(repo, "pnpm-lock.yaml"), "lockfile: v1\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  return { repo };
}

async function teardownFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.repo, { recursive: true, force: true });
}

function runVerifyBundle(
  fixture: Fixture,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("node", [cli, "verify-bundle", ...args], {
    cwd: options.cwd ?? fixture.repo,
    env: options.env ?? process.env,
  });
  return {
    stdout: result.stdout?.toString("utf8") ?? "",
    stderr: result.stderr?.toString("utf8") ?? "",
    status: result.status ?? 1,
  };
}

function bundlePathFromStdout(stdout: string): string {
  const match = stdout.match(/wrote (.+\.md)/);
  assert.ok(match, `expected stdout to name the bundle path, got: ${stdout}`);
  const path = match[1];
  assert.ok(path, `expected a captured path in: ${stdout}`);
  return path.trim();
}

test("verify-bundle captures staged, unstaged, and untracked changes, honoring ignorePatterns", async () => {
  const fixture = await setupFixture();
  try {
    // staged change
    await writeFile(join(fixture.repo, "tracked.txt"), "line one\nline two\nSTAGED CHANGE\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: fixture.repo });

    // unstaged change to a second tracked file
    await writeFile(join(fixture.repo, "second.txt"), "second file content\n");
    execFileSync("git", ["add", "second.txt"], { cwd: fixture.repo });
    execFileSync("git", ["commit", "-q", "-m", "add second"], { cwd: fixture.repo });
    await writeFile(join(fixture.repo, "second.txt"), "second file content\nUNSTAGED CHANGE\n");

    // ignored file changes (default ignorePatterns includes pnpm-lock.yaml)
    await writeFile(join(fixture.repo, "pnpm-lock.yaml"), "lockfile: v2 — should be excluded\n");

    // untracked file
    await writeFile(join(fixture.repo, "new-file.md"), "brand new untracked content\n");

    const { stdout, status } = runVerifyBundle(fixture, []);
    assert.equal(status, 0, stdout);

    const outPath = bundlePathFromStdout(stdout);
    const bundle = await readFile(outPath, "utf8");

    assert.match(bundle, /STAGED CHANGE/, "staged change must appear in the diff");
    assert.match(bundle, /UNSTAGED CHANGE/, "unstaged change must appear in the diff");
    assert.match(bundle, /new-file\.md/, "untracked file must be listed");
    assert.match(bundle, /brand new untracked content/, "untracked file content must be included");
    assert.doesNotMatch(bundle, /should be excluded/, "ignorePatterns must exclude pnpm-lock.yaml content");
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle --base diffs from the given ref", async () => {
  const fixture = await setupFixture();
  try {
    const initialRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.repo }).toString("utf8").trim();

    await writeFile(join(fixture.repo, "tracked.txt"), "line one\nline two\nCOMMITTED CHANGE\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: fixture.repo });
    execFileSync("git", ["commit", "-q", "-m", "second commit"], { cwd: fixture.repo });

    const { stdout, status } = runVerifyBundle(fixture, ["--base", initialRef]);
    assert.equal(status, 0, stdout);

    const outPath = bundlePathFromStdout(stdout);
    const bundle = await readFile(outPath, "utf8");
    assert.match(bundle, /COMMITTED CHANGE/, "diff against the given base must include the later commit");
    assert.match(bundle, new RegExp(initialRef));
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle --out writes to the given path instead of the default", async () => {
  const fixture = await setupFixture();
  try {
    await writeFile(join(fixture.repo, "tracked.txt"), "line one\nline two\nCHANGE\n");
    const outFile = join(fixture.repo, "custom-bundle.md");

    const { stdout, status } = runVerifyBundle(fixture, ["--out", outFile]);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /wrote/);

    const bundle = await readFile(outFile, "utf8");
    assert.match(bundle, /CHANGE/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle default output lands outside the repo tree, under praxarch's own home", async () => {
  const fixture = await setupFixture();
  const praxarchHome = await mkdtemp(join(tmpdir(), "praxarch-home-"));
  try {
    await writeFile(join(fixture.repo, "tracked.txt"), "line one\nline two\nCHANGE\n");

    const { stdout, status } = runVerifyBundle(fixture, [], {
      env: { ...process.env, PRAXARCH_HOME: praxarchHome },
    });
    assert.equal(status, 0, stdout);

    const outPath = bundlePathFromStdout(stdout);

    // The real safety assertion: the default bundle location must sit outside the target repo's
    // working tree unconditionally, not merely be shaped like a path under it — a repo-relative
    // default can only be as safe as that repo's own (praxarch-uncontrolled) .gitignore content.
    assert.ok(isAbsolute(outPath), `expected an absolute path, got: ${outPath}`);
    const relativeToRepo = relative(fixture.repo, outPath);
    assert.ok(
      relativeToRepo.startsWith(".."),
      `expected the default bundle to land outside ${fixture.repo}, got: ${outPath}`,
    );
    assert.ok(
      outPath.startsWith(praxarchHome),
      `expected the default bundle under praxarch's home (${praxarchHome}), got: ${outPath}`,
    );

    const bundle = await readFile(outPath, "utf8");
    assert.match(bundle, /CHANGE/);
  } finally {
    await teardownFixture(fixture);
    await rm(praxarchHome, { recursive: true, force: true });
  }
});

test("verify-bundle --test-cmd includes the command's output", async () => {
  const fixture = await setupFixture();
  try {
    const { stdout, status } = runVerifyBundle(fixture, ["--test-cmd", "echo hello-from-test-cmd"]);
    assert.equal(status, 0, stdout);

    const outPath = bundlePathFromStdout(stdout);
    const bundle = await readFile(outPath, "utf8");
    assert.match(bundle, /hello-from-test-cmd/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle captures a renamed file's diff", async () => {
  const fixture = await setupFixture();
  try {
    execFileSync("git", ["mv", "tracked.txt", "renamed.txt"], { cwd: fixture.repo });
    await writeFile(join(fixture.repo, "renamed.txt"), "line one\nline two\nRENAMED CHANGE\n");
    execFileSync("git", ["add", "renamed.txt"], { cwd: fixture.repo });

    const { stdout, status } = runVerifyBundle(fixture, []);
    assert.equal(status, 0, stdout);

    const outPath = bundlePathFromStdout(stdout);
    const bundle = await readFile(outPath, "utf8");
    assert.match(bundle, /renamed\.txt/, "the diff must mention the new path");
    assert.match(bundle, /RENAMED CHANGE/, "the diff must include the renamed file's content change");
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle captures the diff when invoked from a subdirectory", async () => {
  const fixture = await setupFixture();
  try {
    await mkdir(join(fixture.repo, "sub"), { recursive: true });
    await writeFile(join(fixture.repo, "sub", "nested.txt"), "nested content\n");
    execFileSync("git", ["add", "sub/nested.txt"], { cwd: fixture.repo });
    execFileSync("git", ["commit", "-q", "-m", "add nested"], { cwd: fixture.repo });
    await writeFile(join(fixture.repo, "sub", "nested.txt"), "nested content\nSUBDIR CHANGE\n");

    const { stdout, status } = runVerifyBundle(fixture, [], { cwd: join(fixture.repo, "sub") });
    assert.equal(status, 0, stdout);

    const outPath = bundlePathFromStdout(stdout);
    const bundle = await readFile(outPath, "utf8");
    assert.match(bundle, /SUBDIR CHANGE/, "a change under a subdirectory must appear when run from that subdirectory");
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle captures a non-ASCII filename's diff", async () => {
  const fixture = await setupFixture();
  try {
    // Without this, git's own diff/stat output octal-escapes the filename (`"caf\303\251.txt"`) --
    // this test is about verify-bundle not mangling or dropping the diff for a non-ASCII path, not
    // about git's own quoting convention, so ask git for the literal UTF-8 form.
    execFileSync("git", ["config", "core.quotePath", "false"], { cwd: fixture.repo });
    await writeFile(join(fixture.repo, "café.txt"), "hello\n");
    execFileSync("git", ["add", "café.txt"], { cwd: fixture.repo });
    execFileSync("git", ["commit", "-q", "-m", "add café.txt"], { cwd: fixture.repo });
    await writeFile(join(fixture.repo, "café.txt"), "hello\nNON-ASCII CHANGE\n");

    const { stdout, status } = runVerifyBundle(fixture, []);
    assert.equal(status, 0, stdout);

    const outPath = bundlePathFromStdout(stdout);
    const bundle = await readFile(outPath, "utf8");
    assert.match(bundle, /café\.txt/, "the diff must mention the non-ASCII filename");
    assert.match(bundle, /NON-ASCII CHANGE/, "the diff must include the non-ASCII file's content change");
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle errors on a flag with a missing value instead of silently using the default", async () => {
  const fixture = await setupFixture();
  try {
    const { stderr, status } = runVerifyBundle(fixture, ["--out"]);
    assert.notEqual(status, 0);
    assert.match(stderr, /--out requires a value/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle errors when a flag's value is itself another flag", async () => {
  const fixture = await setupFixture();
  try {
    const { stderr, status } = runVerifyBundle(fixture, ["--out", "--base"]);
    assert.notEqual(status, 0);
    assert.match(stderr, /--out requires a value/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle succeeds when a tracked file typechanges (regular file -> symlink), instead of erroring out on the whole diff", async () => {
  const fixture = await setupFixture();
  try {
    await writeFile(join(fixture.repo, "real.json"), '{"b":2}\n');
    execFileSync("git", ["add", "real.json"], { cwd: fixture.repo });
    execFileSync("git", ["commit", "-q", "-m", "add real.json"], { cwd: fixture.repo });

    // config.json (tracked as a regular file from setupFixture's commit isn't present — add one
    // first, then typechange it) — replace a tracked regular file with a symlink to another
    // tracked file. `git diff` renders this as two "diff --git" sections (a deleted-regular-file
    // half and a new-symlink half) sharing one --numstat record, which is exactly the shape that
    // used to crash the whole command.
    await writeFile(join(fixture.repo, "config.json"), '{"a":1}\n');
    execFileSync("git", ["add", "config.json"], { cwd: fixture.repo });
    execFileSync("git", ["commit", "-q", "-m", "add config.json"], { cwd: fixture.repo });
    await unlink(join(fixture.repo, "config.json"));
    await symlink("real.json", join(fixture.repo, "config.json"));

    const { stdout, stderr, status } = runVerifyBundle(fixture, []);
    assert.equal(status, 0, `expected success, got stderr: ${stderr}`);

    const outPath = bundlePathFromStdout(stdout);
    const bundle = await readFile(outPath, "utf8");
    assert.match(bundle, /deleted file mode/, "the delete half of the typechange must appear");
    assert.match(bundle, /new file mode 120000/, "the new-symlink half of the typechange must appear");
    assert.match(bundle, /config\.json/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle excludes both halves of an ignored file's typechange while still including an unrelated kept file's diff", async () => {
  const fixture = await setupFixture();
  try {
    await writeFile(join(fixture.repo, "real.json"), '{"b":2}\n');
    // pnpm-lock.yaml already exists from setupFixture and matches the default ignorePatterns —
    // typechange it (regular file -> symlink) so both its diff sections must be excluded together.
    execFileSync("git", ["add", "real.json"], { cwd: fixture.repo });
    execFileSync("git", ["commit", "-q", "-m", "add real.json"], { cwd: fixture.repo });
    await unlink(join(fixture.repo, "pnpm-lock.yaml"));
    await symlink("real.json", join(fixture.repo, "pnpm-lock.yaml"));

    // An ordinary kept change alongside it, to confirm the ignored typechange doesn't take down
    // (or get muddled with) the rest of the bundle.
    await writeFile(join(fixture.repo, "tracked.txt"), "line one\nline two\nKEPT CHANGE\n");

    const { stdout, stderr, status } = runVerifyBundle(fixture, []);
    assert.equal(status, 0, `expected success, got stderr: ${stderr}`);

    const outPath = bundlePathFromStdout(stdout);
    const bundle = await readFile(outPath, "utf8");
    assert.doesNotMatch(bundle, /pnpm-lock\.yaml/, "neither half of the ignored file's typechange may appear");
    assert.doesNotMatch(bundle, /new file mode 120000/, "the ignored typechange's symlink half must be excluded too");
    assert.match(bundle, /KEPT CHANGE/, "the unrelated kept file's diff must still appear");
    assert.match(bundle, /tracked\.txt/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle supports --out=<path> equals-form syntax", async () => {
  const fixture = await setupFixture();
  try {
    await writeFile(join(fixture.repo, "tracked.txt"), "line one\nline two\nEQUALS CHANGE\n");
    const outFile = join(fixture.repo, "equals-bundle.md");

    const { stdout, status } = runVerifyBundle(fixture, [`--out=${outFile}`]);
    assert.equal(status, 0, stdout);
    assert.match(stdout, new RegExp(outFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const bundle = await readFile(outFile, "utf8");
    assert.match(bundle, /EQUALS CHANGE/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle errors on --out= with an empty value instead of silently falling back to the default", async () => {
  const fixture = await setupFixture();
  try {
    const { stderr, status } = runVerifyBundle(fixture, ["--out="]);
    assert.notEqual(status, 0);
    assert.match(stderr, /--out requires a value/);
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle succeeds under diff.noprefix=true, which strips the a/ b/ header prefixes entirely", async () => {
  const fixture = await setupFixture();
  try {
    execFileSync("git", ["config", "diff.noprefix", "true"], { cwd: fixture.repo });
    await writeFile(join(fixture.repo, "tracked.txt"), "line one\nline two\nNOPREFIX CHANGE\n");
    await writeFile(join(fixture.repo, "second.txt"), "second file content\n");
    execFileSync("git", ["add", "second.txt"], { cwd: fixture.repo });
    execFileSync("git", ["commit", "-q", "-m", "add second"], { cwd: fixture.repo });
    await writeFile(join(fixture.repo, "second.txt"), "second file content\nOTHER CHANGE\n");

    const { stdout, stderr, status } = runVerifyBundle(fixture, []);
    assert.equal(status, 0, `expected success, got stderr: ${stderr}`);

    const outPath = bundlePathFromStdout(stdout);
    const bundle = await readFile(outPath, "utf8");
    assert.match(bundle, /NOPREFIX CHANGE/, "the diff content must appear even with diff.noprefix set");
    assert.match(bundle, /OTHER CHANGE/, "a second file's diff must also appear, correctly separated from the first");
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle succeeds under diff.mnemonicPrefix=true, which changes the a/ b/ header prefixes", async () => {
  const fixture = await setupFixture();
  try {
    execFileSync("git", ["config", "diff.mnemonicPrefix", "true"], { cwd: fixture.repo });
    await writeFile(join(fixture.repo, "tracked.txt"), "line one\nline two\nMNEMONIC CHANGE\n");

    const { stdout, stderr, status } = runVerifyBundle(fixture, []);
    assert.equal(status, 0, `expected success, got stderr: ${stderr}`);

    const outPath = bundlePathFromStdout(stdout);
    const bundle = await readFile(outPath, "utf8");
    assert.match(bundle, /MNEMONIC CHANGE/, "the diff content must appear even with diff.mnemonicPrefix set");
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle succeeds under diff.relative=true, which would otherwise silently drop changes outside cwd", async () => {
  const fixture = await setupFixture();
  try {
    await mkdir(join(fixture.repo, "sub"), { recursive: true });
    await writeFile(join(fixture.repo, "sub", "nested.txt"), "nested content\n");
    execFileSync("git", ["add", "sub/nested.txt"], { cwd: fixture.repo });
    execFileSync("git", ["commit", "-q", "-m", "add nested"], { cwd: fixture.repo });

    execFileSync("git", ["config", "diff.relative", "true"], { cwd: fixture.repo });

    // Root-level tracked change plus a change under a subdirectory, then invoke from that
    // subdirectory — `diff.relative` restricts unpatched `git diff`/`--numstat`/`--raw` output to
    // paths under cwd, which would silently drop the root-level file's change entirely.
    await writeFile(join(fixture.repo, "tracked.txt"), "line one\nline two\nROOT CHANGE\n");
    await writeFile(join(fixture.repo, "sub", "nested.txt"), "nested content\nSUBDIR CHANGE\n");
    await writeFile(join(fixture.repo, "root-untracked.md"), "root untracked content\n");

    const { stdout, stderr, status } = runVerifyBundle(fixture, [], { cwd: join(fixture.repo, "sub") });
    assert.equal(status, 0, `expected success, got stderr: ${stderr}`);

    const outPath = bundlePathFromStdout(stdout);
    const bundle = await readFile(outPath, "utf8");
    assert.match(bundle, /ROOT CHANGE/, "a root-level tracked change must appear even under diff.relative=true");
    assert.match(bundle, /SUBDIR CHANGE/, "a subdirectory tracked change must still appear");
    assert.match(bundle, /root-untracked\.md/, "a root-level untracked file must still be listed");
  } finally {
    await teardownFixture(fixture);
  }
});

async function setupSubmoduleFixture(): Promise<Fixture & { subRepo: string }> {
  const fixture = await setupFixture();
  const subRepo = await mkdtemp(join(tmpdir(), "praxarch-verify-bundle-submodule-"));
  execFileSync("git", ["init", "-q"], { cwd: subRepo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: subRepo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: subRepo });
  await writeFile(join(subRepo, "f.txt"), "a\n");
  execFileSync("git", ["add", "f.txt"], { cwd: subRepo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: subRepo });

  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subRepo, "sub"], {
    cwd: fixture.repo,
  });
  execFileSync("git", ["commit", "-q", "-m", "add submodule"], { cwd: fixture.repo });

  // The submodule checkout is a fresh clone and doesn't inherit subRepo's identity config.
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: join(fixture.repo, "sub") });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: join(fixture.repo, "sub") });

  // Bump the submodule's own HEAD so the outer repo sees a pointer change without staging it.
  await writeFile(join(fixture.repo, "sub", "f.txt"), "a\nb\n");
  execFileSync("git", ["commit", "-qam", "bump"], { cwd: join(fixture.repo, "sub") });

  return { ...fixture, subRepo };
}

test("verify-bundle succeeds under diff.submodule=log, which would otherwise under-supply diff sections and fail the whole command", async () => {
  const fixture = await setupSubmoduleFixture();
  try {
    execFileSync("git", ["config", "diff.submodule", "log"], { cwd: fixture.repo });

    // An unrelated ordinary change alongside the submodule pointer change, to confirm the
    // section-count guard doesn't take down the rest of the bundle.
    await writeFile(join(fixture.repo, "tracked.txt"), "line one\nline two\nKEPT CHANGE\n");

    const { stdout, stderr, status } = runVerifyBundle(fixture, []);
    assert.equal(status, 0, `expected success, got stderr: ${stderr}`);

    const outPath = bundlePathFromStdout(stdout);
    const bundle = await readFile(outPath, "utf8");
    assert.match(bundle, /diff --git a\/sub b\/sub/, "the submodule pointer change must render as an ordinary diff --git section");
    assert.match(bundle, /Subproject commit/, "the submodule diff body must appear");
    assert.match(bundle, /KEPT CHANGE/, "an unrelated ordinary change must still appear");
  } finally {
    await teardownFixture(fixture);
    await rm(fixture.subRepo, { recursive: true, force: true });
  }
});

test("verify-bundle succeeds under diff.submodule=diff, which would otherwise over-supply diff sections and fail the whole command", async () => {
  const fixture = await setupSubmoduleFixture();
  try {
    execFileSync("git", ["config", "diff.submodule", "diff"], { cwd: fixture.repo });

    const { stdout, stderr, status } = runVerifyBundle(fixture, []);
    assert.equal(status, 0, `expected success, got stderr: ${stderr}`);

    const outPath = bundlePathFromStdout(stdout);
    const bundle = await readFile(outPath, "utf8");
    assert.match(bundle, /diff --git a\/sub b\/sub/, "the submodule pointer change must render as an ordinary diff --git section");
    assert.doesNotMatch(bundle, /diff --git a\/f\.txt b\/f\.txt/, "the submodule's own inner diff must not be injected into the outer patch");
  } finally {
    await teardownFixture(fixture);
    await rm(fixture.subRepo, { recursive: true, force: true });
  }
});

test("verify-bundle succeeds under color.ui=always, which would otherwise embed ANSI escapes and break the header split", async () => {
  const fixture = await setupFixture();
  try {
    execFileSync("git", ["config", "color.ui", "always"], { cwd: fixture.repo });
    await writeFile(join(fixture.repo, "tracked.txt"), "line one\nline two\nCOLOR CHANGE\n");
    await writeFile(join(fixture.repo, "second.txt"), "second file content\n");
    execFileSync("git", ["add", "second.txt"], { cwd: fixture.repo });
    execFileSync("git", ["commit", "-q", "-m", "add second"], { cwd: fixture.repo });
    await writeFile(join(fixture.repo, "second.txt"), "second file content\nOTHER COLOR CHANGE\n");

    const { stdout, stderr, status } = runVerifyBundle(fixture, []);
    assert.equal(status, 0, `expected success, got stderr: ${stderr}`);

    const outPath = bundlePathFromStdout(stdout);
    const bundle = await readFile(outPath, "utf8");
    assert.match(bundle, /COLOR CHANGE/, "the diff content must appear even with color.ui=always set");
    assert.match(bundle, /OTHER COLOR CHANGE/, "a second file's diff must also appear, correctly separated from the first");
    assert.ok(!bundle.includes("\x1b["), "no raw ANSI escape codes may appear in the bundle");
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle captures a tracked file whose name contains a literal backslash", async () => {
  const fixture = await setupFixture();
  try {
    const oddName = "back\\slash.txt";
    await writeFile(join(fixture.repo, oddName), "hello\n");
    execFileSync("git", ["add", oddName], { cwd: fixture.repo });
    execFileSync("git", ["commit", "-q", "-m", "add backslash file"], { cwd: fixture.repo });
    await writeFile(join(fixture.repo, oddName), "hello\nBACKSLASH CHANGE\n");
    // A normal file alongside it, to prove the odd path's quoted header doesn't desync the mapping
    // for anything after it.
    await writeFile(join(fixture.repo, "tracked.txt"), "line one\nline two\nNORMAL CHANGE\n");

    const { stdout, stderr, status } = runVerifyBundle(fixture, []);
    assert.equal(status, 0, `expected success, got stderr: ${stderr}`);

    const outPath = bundlePathFromStdout(stdout);
    const bundle = await readFile(outPath, "utf8");
    assert.match(bundle, /BACKSLASH CHANGE/, "the backslash-named file's diff must appear");
    assert.match(bundle, /NORMAL CHANGE/, "the normal file alongside it must still appear correctly");
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle captures a tracked file whose name contains a literal double-quote", async () => {
  const fixture = await setupFixture();
  try {
    const oddName = 'qu"ote.txt';
    await writeFile(join(fixture.repo, oddName), "hello\n");
    execFileSync("git", ["add", oddName], { cwd: fixture.repo });
    execFileSync("git", ["commit", "-q", "-m", "add quote file"], { cwd: fixture.repo });
    await writeFile(join(fixture.repo, oddName), "hello\nQUOTE CHANGE\n");
    // A normal file alongside it, to prove the odd path's quoted header doesn't desync the mapping
    // for anything after it.
    await writeFile(join(fixture.repo, "tracked.txt"), "line one\nline two\nNORMAL CHANGE\n");

    const { stdout, stderr, status } = runVerifyBundle(fixture, []);
    assert.equal(status, 0, `expected success, got stderr: ${stderr}`);

    const outPath = bundlePathFromStdout(stdout);
    const bundle = await readFile(outPath, "utf8");
    assert.match(bundle, /QUOTE CHANGE/, "the quote-named file's diff must appear");
    assert.match(bundle, /NORMAL CHANGE/, "the normal file alongside it must still appear correctly");
  } finally {
    await teardownFixture(fixture);
  }
});

test("verify-bundle fails cleanly outside a git repo", async () => {
  const nonRepo = await mkdtemp(join(tmpdir(), "praxarch-verify-bundle-non-repo-"));
  try {
    const result = spawnSync("node", [cli, "verify-bundle"], { cwd: nonRepo });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString("utf8"), /not inside a git working tree/);
  } finally {
    await rm(nonRepo, { recursive: true, force: true });
  }
});
