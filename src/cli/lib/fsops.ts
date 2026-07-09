import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
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

/** Copies src to dest, backing up an existing dest to dest.praxarch-backup-<timestamp> first. */
export async function copyWithBackup(src: string, dest: string): Promise<{ backedUp: boolean }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  let backedUp = false;
  if (await exists(dest)) {
    await cp(dest, `${dest}.praxarch-backup-${timestamp}`);
    backedUp = true;
  }
  await mkdir(dest.split("/").slice(0, -1).join("/"), { recursive: true });
  await cp(src, dest, { recursive: true });
  return { backedUp };
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
