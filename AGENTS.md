# Agent notes

Rules for agents editing this codebase.

- In a hook with a watchdog or fail-open path, anything slow that is awaited on the decision
  path goes *after* the decision is emitted, with the watchdog disarmed, never before. See
  `src/hooks/verify-gate.ts`: `fireWatchdog` bails out once a decision has already reached
  stdout, and the block path emits before awaiting its own audit-log append. This covers
  best-effort audit/log appends (`logEscapeHatch`, `logUnneededWaiver`, and the like) on a
  decision path with a watchdog. Deliberate exceptions: the accepted-waiver path writes session
  state (`updateSessionState`) before emitting, because the stored waiver hash is what later
  stops rely on; the `PRAXARCH_SKIP_VERIFY` path and the crash handler predate this rule.
- JSONL appends go through `appendJsonl` in `src/hooks/lib/jsonl.ts`, which opens O_NONBLOCK
  and loops on short writes. Don't add raw `appendFile` calls on hook paths.
