const START_MARKER = "<!-- praxarch:orchestration:start -->";
const END_MARKER = "<!-- praxarch:orchestration:end -->";

export interface ClaudeMdMergeResult {
  content: string;
  changed: boolean;
  action: "inserted" | "updated" | "unchanged";
}

/**
 * Upserts the praxarch orchestration policy block into a CLAUDE.md, delimited by marker
 * comments so re-running install replaces exactly that block and leaves the rest of the user's
 * CLAUDE.md untouched.
 */
export function upsertOrchestrationBlock(existing: string, block: string): ClaudeMdMergeResult {
  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + END_MARKER.length);
    const current = existing.slice(startIdx, endIdx + END_MARKER.length);
    if (current.trim() === block.trim()) {
      return { content: existing, changed: false, action: "unchanged" };
    }
    return { content: `${before}${block}${after}`, changed: true, action: "updated" };
  }

  const separator = existing.length > 0 && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
  return { content: `${existing}${separator}${block}`, changed: true, action: "inserted" };
}
