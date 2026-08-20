import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AGENTS_DIR,
  CLAUDE_MD_PATH,
  DIST_DIR,
  PRAXARCH_INSTALL_DIR,
  REPO_ROOT,
  SETTINGS_PATH,
  SKILLS_DIR,
  TEMPLATES_DIR,
} from "./lib/paths.js";
import { exists, isJsonObject, readJsonIfExists, readTextIfExists } from "./lib/fsops.js";
import { readJsonl } from "../hooks/lib/jsonl.js";
import { logDir } from "../hooks/lib/paths.js";

const execFileAsync = promisify(execFile);

// Lowercase "explore" — the template/installed file is explore.md (the agent's *name* is
// "Explore", from frontmatter). Checking "Explore.md" only passed on case-insensitive filesystems.
const ROLE_FILES = ["scout", "explore", "mech-executor", "executor", "verifier", "checker", "security-executor", "planner", "implementer", "plan-reviewer"];
const SKILL_NAMES = ["praxarch-report", "fan-out", "orchestrate"];

interface Check {
  ok: boolean;
  message: string;
}

// Derived from templates/settings.fragment.json — the single source of truth for which hook
// events praxarch registers — so a newly added event is checked automatically without a matching
// edit here. A hardcoded list would silently stop covering new events (issue #15's failure shape:
// a hook that isn't firing, with no diagnostic).
//
// A malformed or absent fragment must NOT be treated as "zero events to check" — that would make
// every hook-wiring check vacuously pass (iterating zero events reports nothing failing), exactly
// how a broken shipped template silently turned into "21/21 checks passed" even though nothing
// about the hooks was actually verified. So this returns a Check on failure instead of `[]`, and
// the caller must surface it rather than swallow it.
async function shippedHookEvents(): Promise<{ events: string[] } | { failure: Check }> {
  const fragmentPath = join(TEMPLATES_DIR, "settings.fragment.json");
  const fragment = await readJsonIfExists<{ hooks?: Record<string, unknown> }>(fragmentPath);
  if (fragment.status === "absent") {
    return { failure: { ok: false, message: `${fragmentPath} does not exist — cannot verify praxarch's hooks are wired.` } };
  }
  if (fragment.status === "malformed") {
    return { failure: { ok: false, message: `${fragmentPath} is not valid JSON: ${fragment.error.message}` } };
  }
  if (!isJsonObject(fragment.value)) {
    return {
      failure: {
        ok: false,
        message: `${fragmentPath} does not contain a JSON object — cannot verify praxarch's hooks are wired.`,
      },
    };
  }
  return { events: Object.keys(fragment.value.hooks ?? {}) };
}

async function checkSettings(): Promise<Check[]> {
  const checks: Check[] = [];
  const result = await readJsonIfExists<Record<string, unknown>>(SETTINGS_PATH);
  if (result.status === "absent") {
    return [{ ok: false, message: `${SETTINGS_PATH} does not exist — run \`praxarch install\`.` }];
  }
  if (result.status === "malformed") {
    // Hooks/statusLine checks below need a parsed object to inspect — nothing to check against a
    // file that didn't parse, so report the one failure and stop here. doctor() itself still runs
    // every other top-level check; only this function's own remaining logic is skipped.
    return [{ ok: false, message: `${SETTINGS_PATH} is not valid JSON: ${result.error.message}` }];
  }
  if (!isJsonObject(result.value)) {
    // Well-formed JSON (e.g. `null`, `[]`, `42`) that isn't an object — same "nothing to check
    // against" situation as malformed, so report it the same way rather than crashing on property
    // access below.
    return [
      {
        ok: false,
        message: `${SETTINGS_PATH} does not contain a JSON object (got ${JSON.stringify(result.value)}) — run \`praxarch install\` to fix it.`,
      },
    ];
  }
  const settings = result.value;
  checks.push({ ok: settings["model"] !== undefined, message: "settings.json has a model set" });
  const hooks = settings["hooks"] as Record<string, { hooks?: { command: string }[] }[]> | undefined;
  const hasHook = (event: string): boolean =>
    (hooks?.[event] ?? []).some((g) => (g.hooks ?? []).some((h) => h.command.includes("praxarch")));
  const shipped = await shippedHookEvents();
  if ("failure" in shipped) {
    checks.push(shipped.failure);
  } else {
    for (const event of shipped.events) {
      checks.push({ ok: hasHook(event), message: `settings.json wires the praxarch ${event} hook` });
    }
  }
  const statusLine = settings["statusLine"] as { command?: string } | undefined;
  checks.push({
    ok: Boolean(statusLine?.command?.includes("praxarch")),
    message: "settings.json statusLine points at praxarch",
  });
  return checks;
}

async function checkClaudeMd(): Promise<Check> {
  const content = await readTextIfExists(CLAUDE_MD_PATH);
  const ok = Boolean(content?.includes("<!-- praxarch:orchestration:start -->"));
  return { ok, message: "CLAUDE.md has the praxarch orchestration policy block" };
}

async function checkAgents(): Promise<Check[]> {
  const checks: Check[] = [];
  for (const role of ROLE_FILES) {
    checks.push({
      ok: await exists(join(AGENTS_DIR, `${role}.md`)),
      message: `agents/${role}.md is installed`,
    });
  }
  return checks;
}

async function checkSkills(): Promise<Check[]> {
  const checks: Check[] = [];
  for (const name of SKILL_NAMES) {
    checks.push({
      ok: await exists(join(SKILLS_DIR, name, "SKILL.md")),
      message: `skills/${name} is installed`,
    });
  }
  return checks;
}

async function checkVersion(): Promise<Check> {
  const versionPath = join(PRAXARCH_INSTALL_DIR, "VERSION.json");
  const result = await readJsonIfExists<{ version: string }>(versionPath);
  if (result.status === "absent") {
    return { ok: false, message: "no VERSION.json found in ~/.claude/praxarch — run `praxarch install`." };
  }
  if (result.status === "malformed") {
    return { ok: false, message: `${versionPath} is not valid JSON: ${result.error.message}` };
  }
  if (!isJsonObject(result.value)) {
    return {
      ok: false,
      message: `${versionPath} does not contain a JSON object (got ${JSON.stringify(result.value)}) — run \`praxarch install\` to fix it.`,
    };
  }
  const installed = result.value;
  const repoVersion = (JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as { version: string })
    .version;
  const ok = installed.version === repoVersion;
  return {
    ok,
    message: ok
      ? `installed version matches repo (${repoVersion})`
      : `installed version ${installed.version} differs from repo ${repoVersion} — run \`praxarch install\` to update`,
  };
}

// Byte-compares every installed file against the repo's dist build, not just directory
// existence — a stale install otherwise passes doctor as long as VERSION strings agree
// (which is exactly how the 2026-07 payload fixes sat undeployed while doctor said 20/20).
async function checkDistTree(): Promise<Check[]> {
  const checks: Check[] = [];
  for (const subdir of ["hooks", "statusline", "report"]) {
    const srcDir = join(DIST_DIR, subdir);
    const destDir = join(PRAXARCH_INSTALL_DIR, subdir);
    if (!(await exists(destDir))) {
      checks.push({ ok: false, message: `praxarch/${subdir}/ is installed` });
      continue;
    }
    if (!(await exists(srcDir))) {
      checks.push({ ok: false, message: `praxarch/${subdir}/: repo has no dist/${subdir} — run \`pnpm build\`` });
      continue;
    }
    // Recursive readdir includes directory entries (e.g. hooks/lib) — keep only the compiled
    // files the installer actually copies.
    const files = (await readdir(srcDir, { recursive: true })).filter(
      (f) => (f.endsWith(".js") || f.endsWith(".js.map")) && !f.includes(".test."),
    );
    const stale: string[] = [];
    for (const file of files) {
      const src = join(srcDir, file);
      const dest = join(destDir, file);
      try {
        const [a, b] = await Promise.all([readFile(src), readFile(dest)]);
        if (!a.equals(b)) stale.push(file);
      } catch {
        stale.push(file);
      }
    }
    checks.push({
      ok: stale.length === 0,
      message:
        stale.length === 0
          ? `praxarch/${subdir}/ matches the repo's dist build`
          : `praxarch/${subdir}/ differs from dist (${stale.join(", ")}) — \`pnpm build\` then \`praxarch install\``,
    });
  }
  return checks;
}

interface BuildInfo {
  ref?: string | null;
  branch?: string | null;
}

async function currentGitRef(): Promise<{ ref: string; branch: string | null } | null> {
  try {
    const [{ stdout: refOut }, { stdout: branchOut }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }),
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: REPO_ROOT }),
    ]);
    const branch = branchOut.trim();
    return { ref: refOut.trim(), branch: branch === "HEAD" ? null : branch };
  } catch {
    return null;
  }
}

// Names the branch/ref the *installed* hooks were built from (issue #14 Part B) and compares it
// against this checkout's live HEAD — the exact mismatch the issue describes (verifying a branch
// silently installs it) is otherwise invisible until something in the hook's own output happens
// to name it. Degrades to an informational pass, never a failure, when either side of the
// comparison is unavailable (pre-#14 install, tarball install, git missing) — a stale-ref check
// that can't determine staleness isn't a defect worth failing doctor over.
// Kept separate from readJsonIfExists' {absent,ok,malformed} result: build-info.json can be
// hand-edited or truncated by an interrupted write, and checkBuildRef's contract is to degrade a
// malformed file to "unknown," the same as a missing one — never surface it as its own failed
// check the way checkSettings/checkVersion do for settings.json/VERSION.json.
async function readBuildInfoIfValid(path: string): Promise<BuildInfo | null> {
  const raw = await readTextIfExists(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as BuildInfo;
  } catch {
    return null;
  }
}

async function checkBuildRef(): Promise<Check> {
  const installed = await readBuildInfoIfValid(join(PRAXARCH_INSTALL_DIR, "hooks", "build-info.json"));
  if (!installed?.ref) {
    return {
      ok: true,
      message:
        "installed hooks' build ref is unknown (pre-#14 install, git was unavailable at build time, or build-info.json is unreadable)",
    };
  }
  const current = await currentGitRef();
  const shortInstalled = installed.ref.slice(0, 12);
  const installedLabel = `${installed.branch ?? "detached HEAD"}@${shortInstalled}`;
  if (!current) {
    return { ok: true, message: `installed hooks were built from ${installedLabel} — this checkout's current ref could not be determined` };
  }
  const currentLabel = `${current.branch ?? "detached HEAD"}@${current.ref.slice(0, 12)}`;
  const ok = installed.ref === current.ref;
  return {
    ok,
    message: ok
      ? `installed hooks match this checkout's HEAD (${currentLabel})`
      : `installed hooks were built from ${installedLabel} — this checkout is now on ${currentLabel}; ` +
        "`pnpm build` to sync (or `git checkout main && pnpm build` to restore merged code)",
  };
}

// --- Inherited-model audit (issue #24) ----------------------------------------------------------
// #7's postmortem: route-guard enforces the "known role must not pass an explicit model" rule only
// at PreToolUse, before a model is resolved. Whether a given `model:"inherited"` dispatch actually
// landed on its role's bound tier is a question only telemetry (which records resolvedModel) and
// the installed agent frontmatter (which records the binding) can answer together, after the fact.
// Nothing compared the two before this check existed.

// A week is long enough to catch a stale/mid-window binding change (the issue explicitly says
// that's fine to report as-is, not something to suppress) without doctor re-reading a whole
// history's worth of monthly JSONL files on every run — doctor is meant to be a quick health
// check, not a report.
const INHERITED_MODEL_AUDIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface DelegationLogRow {
  at: string;
  role?: string;
  model?: string;
  resolvedModel?: string | null;
  event?: string;
}

interface DoctorAgentFrontmatter {
  name?: string;
  model?: string;
}

// Deliberately duplicated from report.ts's parseFrontmatter rather than shared: both are a few
// lines, and doctor/report read from different directory-resolution env vars (AGENTS_DIR here is
// CLAUDE_HOME-based/PRAXARCH_TARGET_CLAUDE_HOME, report's agentsDir() is PRAXARCH_AGENTS_DIR-based)
// — collapsing them into one shared helper would either force one on the other's env var or add an
// indirection layer neither file needs for a parser this small.
function parseDoctorFrontmatter(content: string): DoctorAgentFrontmatter | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const result: DoctorAgentFrontmatter = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = (rawValue ?? "").trim().replace(/^["']|["']$/g, "");
    if (key === "name") result.name = value;
    else if (key === "model") result.model = value;
  }
  return result;
}

// `undefined` in the returned map (via `.has()` returning false) means "no agent file names this
// role, or its frontmatter didn't parse" — deliberately distinct from a present key whose value is
// `null` ("this role's frontmatter has no model: key, i.e. it's designed to inherit"). The audit
// below warns on the former (nothing to check the binding against) and treats the latter as
// nothing-to-disagree-with (there's no bound tier for an observed model to diverge from).
async function loadDoctorAgentBindings(): Promise<Map<string, string | null>> {
  const bindings = new Map<string, string | null>();
  let files: string[];
  try {
    files = (await readdir(AGENTS_DIR)).filter((f) => f.endsWith(".md"));
  } catch {
    return bindings;
  }
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(join(AGENTS_DIR, file), "utf8");
    } catch {
      continue;
    }
    const parsed = parseDoctorFrontmatter(content);
    if (!parsed?.name) continue;
    bindings.set(parsed.name, parsed.model ?? null);
  }
  return bindings;
}

// Same substring-containment reasoning as report.ts's modelAgrees: a bound tier name ("opus") is
// never string-equal to an observed API model id ("claude-opus-4-8"), so agreement means the bound
// tier name appears in the observed id.
function doctorModelAgrees(bound: string, observed: string): boolean {
  return observed.toLowerCase().includes(bound.toLowerCase());
}

async function checkInheritedModelAudit(): Promise<Check[]> {
  let files: string[];
  try {
    files = (await readdir(logDir())).filter((f) => f.endsWith(".jsonl"));
  } catch {
    // No logs yet (fresh install, or PRAXARCH_HOME not yet used) — nothing to audit, and that's
    // not itself a health problem.
    return [{ ok: true, message: "inherited-model audit: no telemetry logs to audit yet" }];
  }

  const cutoff = Date.now() - INHERITED_MODEL_AUDIT_WINDOW_MS;
  // Log filenames are YYYY-MM.jsonl (one file per calendar month, see hooks/lib/paths.ts). A
  // 7-day window can straddle a month boundary but never spans more than two calendar months, so
  // any file whose YYYY-MM prefix is older than the cutoff's month cannot contain an in-window
  // row — skip parsing it rather than reading (and discarding) a whole history's worth of JSONL.
  const cutoffMonthPrefix = new Date(cutoff).toISOString().slice(0, 7);
  const candidateFiles = files.filter((f) => f.slice(0, 7) >= cutoffMonthPrefix);
  const rows: DelegationLogRow[] = [];
  for (const file of candidateFiles.sort()) {
    rows.push(...(await readJsonl<DelegationLogRow>(join(logDir(), file))));
  }

  // Event rows (verifyGateFailOpen, guard-crash) carry `event` instead of `role`/`model` — must
  // not be misread as a delegation with role "undefined". Only `model:"inherited"` rows with a
  // real resolvedModel are auditable at all: a null/absent resolvedModel means the dispatch never
  // resolved (crashed, or predates token/model capture), so there's nothing to compare.
  const recent = rows.filter(
    (r): r is DelegationLogRow & { role: string; resolvedModel: string } =>
      r.event === undefined &&
      r.model === "inherited" &&
      typeof r.role === "string" &&
      typeof r.resolvedModel === "string" &&
      r.resolvedModel.length > 0 &&
      !Number.isNaN(Date.parse(r.at)) &&
      Date.parse(r.at) >= cutoff,
  );

  if (recent.length === 0) {
    return [{ ok: true, message: "inherited-model audit: no recent inherited-model dispatches to audit" }];
  }

  // observedByRole tracks the *distinct* resolvedModel values per role (for the divergence check
  // below); rowCountByRole tracks how many dispatch rows were actually observed per role. These
  // are not interchangeable — a role can have 6 rows that all resolved to the same model (1
  // distinct value) or 6 rows split across 2 models (2 distinct values). Messages that report "how
  // many dispatches" must use rowCountByRole, not observed.size, or they undercount whenever
  // multiple rows share a resolvedModel.
  const observedByRole = new Map<string, Set<string>>();
  const rowCountByRole = new Map<string, number>();
  for (const r of recent) {
    if (!observedByRole.has(r.role)) observedByRole.set(r.role, new Set());
    observedByRole.get(r.role)?.add(r.resolvedModel);
    rowCountByRole.set(r.role, (rowCountByRole.get(r.role) ?? 0) + 1);
  }

  const bindings = await loadDoctorAgentBindings();
  const checks: Check[] = [];
  for (const [role, observed] of [...observedByRole.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!bindings.has(role)) {
      checks.push({
        ok: false,
        message:
          `inherited-model audit: role "${role}" has ${rowCountByRole.get(role) ?? 0} recent inherited ` +
          `dispatch(es) but no installed agent file names it (or its frontmatter is unparsable) — its ` +
          "binding can't be verified.",
      });
      continue;
    }
    // `.has()` above guarantees a real Map entry, but TS's control-flow analysis doesn't carry
    // that guarantee through a separate `.get()` call, so `.get()` still types as
    // `string | null | undefined` — the `?? null` here is narrowing for the type checker, not a
    // real fallback (the `undefined` branch is unreachable given the `.has()` guard above).
    const bound = bindings.get(role) ?? null;
    // No model: key means this role is designed to inherit — nothing bound to disagree with.
    if (bound === null) continue;
    const diverging = [...observed].filter((m) => !doctorModelAgrees(bound, m)).sort();
    if (diverging.length > 0) {
      checks.push({
        ok: false,
        message:
          `inherited-model audit: role "${role}" is bound to "${bound}" but recent dispatches ` +
          `resolved to ${diverging.join(", ")} — binding may have changed mid-window, or route-guard ` +
          "was bypassed.",
      });
    }
  }

  if (checks.length === 0) {
    checks.push({
      ok: true,
      message: `inherited-model audit: ${recent.length} recent inherited dispatch(es) across ${observedByRole.size} role(s) all match their bindings`,
    });
  }
  return checks;
}

function checkEnv(): Check {
  return {
    ok: !process.env["CLAUDE_CODE_SUBAGENT_MODEL"],
    message: "CLAUDE_CODE_SUBAGENT_MODEL is not set (it would override all role model bindings)",
  };
}

export async function doctor(): Promise<void> {
  const checks: Check[] = [
    ...(await checkSettings()),
    await checkClaudeMd(),
    ...(await checkAgents()),
    ...(await checkSkills()),
    ...(await checkDistTree()),
    await checkVersion(),
    await checkBuildRef(),
    ...(await checkInheritedModelAudit()),
    checkEnv(),
  ];

  let readdirNote = "";
  try {
    const stale = (await readdir(AGENTS_DIR)).filter((f) => f.includes(".praxarch-backup-"));
    if (stale.length > 0) {
      readdirNote = `\nNote: ${stale.length} backup file(s) in agents/ from previous installs — safe to delete once you've confirmed the new versions are correct.`;
    }
  } catch {
    // agents dir may not exist yet; checkAgents already reports that.
  }

  const failing = checks.filter((c) => !c.ok);
  for (const check of checks) {
    process.stdout.write(`${check.ok ? "✓" : "✗"} ${check.message}\n`);
  }
  process.stdout.write(readdirNote ? `${readdirNote}\n` : "");
  process.stdout.write(`\n${checks.length - failing.length}/${checks.length} checks passed.\n`);

  if (failing.length > 0) process.exitCode = 1;
}
