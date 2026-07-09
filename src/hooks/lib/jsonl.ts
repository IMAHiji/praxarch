import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function appendJsonl(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const records: T[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      // Skip malformed lines rather than failing the whole read — a hook
      // crash mid-write should not make historical telemetry unreadable.
    }
  }
  return records;
}
