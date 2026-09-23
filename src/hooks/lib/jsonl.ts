import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function appendJsonl(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // issue #3: opened O_NONBLOCK rather than through fs.promises.appendFile (which opens
  // blocking). A regular file is unaffected by O_NONBLOCK, but a FIFO with no reader attached
  // (the log path pointed at a stale pipe, or similar) fails `open()` immediately with ENXIO
  // instead of hanging in it forever — the hang that forced a watchdog SIGKILL workaround
  // upstream. Callers already treat an append failure as best-effort or report it.
  const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NONBLOCK, 0o644);
  try {
    // issue #3: `handle.write` can write fewer bytes than asked -- a FIFO with an idle reader, or
    // ENOSPC/EDQUOT partway through a row on a regular file. `fs.promises.appendFile` used to loop
    // internally; loop here too rather than trust one call to land the whole row. The loop retries
    // a short write until the row is complete, but if a later write fails (ENOSPC, EDQUOT), the
    // partial row stays on disk and this throws -- it can't undo bytes already written. A 0-byte
    // write (e.g. EAGAIN on a full non-blocking FIFO) makes no progress and would spin forever, so
    // it throws instead of retrying.
    const buf = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    let offset = 0;
    while (offset < buf.length) {
      const { bytesWritten } = await handle.write(buf, offset, buf.length - offset, null);
      if (bytesWritten === 0) {
        throw new Error(`appendJsonl: write to ${path} made no progress (0 bytes written)`);
      }
      offset += bytesWritten;
    }
  } finally {
    await handle.close();
  }
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
