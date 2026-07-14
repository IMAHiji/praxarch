import { access, cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** True if path is itself a symlink. Unlike exists(), does not follow the link. */
export async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function readJsonIfExists<T>(path: string): Promise<T | null> {
  const raw = await readTextIfExists(path);
  return raw === null ? null : (JSON.parse(raw) as T);
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true });
  await writeFile(path, content, "utf8");
}

/**
 * True if `path` resolves inside a praxarch checkout — ANY checkout, not just the one this CLI is
 * running from (a git worktree or second clone is still a git working tree).
 *
 * Such files are praxarch's *sources*, not install targets. Writing through a link into one
 * overwrites tracked templates and litters the repo with .praxarch-backup-* files; deleting through
 * one destroys them outright. Keying this on REPO_ROOT identity instead would protect only the
 * clone you happen to have invoked, which is exactly the case that doesn't need protecting.
 */
export async function resolvesIntoPraxarchRepo(path: string): Promise<boolean> {
  const start = await deepestExistingDir(path);
  if (start === null) return false;

  for (let dir = start; ; ) {
    try {
      const raw = await readFile(join(dir, "package.json"), "utf8");
      if ((JSON.parse(raw) as { name?: string }).name === "praxarch") return true;
    } catch {
      // Absent, unreadable, or not valid JSON. These are other people's files on the way up to /,
      // and this guard runs on the destructive path — it must never throw. Keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Where `path` actually lives, following symlinks — even if `path` itself doesn't exist yet.
 *
 * A dest that has not been created is still going to be written inside whatever its parent
 * resolves to, and that parent may be a link into a checkout. Resolving only `path` would throw
 * ENOENT and lose exactly that fact, which is how a *new* file ends up written into a git repo.
 */
async function deepestExistingDir(path: string): Promise<string | null> {
  const self = await realpathOrNull(path);
  if (self !== null) return dirname(self);

  for (let dir = dirname(path); ; ) {
    const resolved = await realpathOrNull(dir);
    if (resolved !== null) return resolved;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * True if a symlink's target actually exists. Only ENOENT counts as broken — an unreadable parent
 * or an unmounted volume (EACCES, EIO) means "can't tell", and we must not destroy a link over
 * a transient failure.
 */
export async function linkResolves(path: string): Promise<boolean> {
  try {
    await realpath(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export type CopyAction =
  | "created"
  | "overwritten"
  | "already-at-source"
  | "updated-through-symlink"
  | "replaced-broken-symlink"
  | "unreadable-symlink";

/** Identical file content — used to make a reinstall a no-op instead of spawning a fresh backup. */
export async function sameContent(src: string, dest: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([readFile(src), readFile(dest)]);
    return a.equals(b);
  } catch {
    return false; // dest missing, or either side is a directory
  }
}

async function backupAndCopy(src: string, dest: string): Promise<boolean> {
  const existed = await exists(dest);
  if (existed) {
    if (await sameContent(src, dest)) return existed;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    await cp(dest, `${dest}.praxarch-backup-${timestamp}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
  return existed;
}

/**
 * Copies src to dest, backing up an existing dest to dest.praxarch-backup-<timestamp> first.
 *
 * A symlinked dest is the user's deliberate wiring, so the rule is: preserve the link, write
 * *through* it. Replacing the link with a plain copy (the old behavior) silently froze live-linked
 * installs; skipping it outright silently froze links pointing anywhere other than our own source.
 * Writing through keeps the link and keeps the content current, whatever it points at.
 *
 *  - dest resolves into a praxarch checkout — that is a source tree, not an install target. Leave it.
 *  - dest is a live symlink elsewhere (dotfiles, another tool's dir) — copy to its target.
 *  - dest is a *broken* symlink (e.g. praxarch/hooks -> <clone>/dist/hooks after dist/ is removed) —
 *    nothing to preserve, and skipping would leave the install unrepairable. Unlink and write real.
 */
export async function copyWithBackup(src: string, dest: string): Promise<{ action: CopyAction }> {
  if (await resolvesIntoPraxarchRepo(dest)) return { action: "already-at-source" };

  if (await isSymlink(dest)) {
    if (!(await linkResolves(dest))) {
      await rm(dest, { force: true });
      await backupAndCopy(src, dest);
      return { action: "replaced-broken-symlink" };
    }
    const target = await realpathOrNull(dest);
    if (target === null) return { action: "unreadable-symlink" };
    await backupAndCopy(src, target);
    return { action: "updated-through-symlink" };
  }

  return { action: (await backupAndCopy(src, dest)) ? "overwritten" : "created" };
}

/** realpath that reports failure instead of throwing — a self-referential link (ELOOP) must not
 *  abort the whole install. */
export async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/** Writes text to path, backing up the previous content first if it differs. No-ops if unchanged. */
export async function backupThenWriteText(path: string, content: string): Promise<{ changed: boolean }> {
  const previous = await readTextIfExists(path);
  if (previous === content) return { changed: false };
  if (previous !== null) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    await writeFile(`${path}.praxarch-backup-${timestamp}`, previous, "utf8");
  }
  await writeText(path, content);
  return { changed: true };
}

export async function backupThenWriteJson(path: string, value: unknown): Promise<{ changed: boolean }> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  return backupThenWriteText(path, content);
}
