// Hand-written plain JS (not compiled from a .ts sibling) with a co-located dist-dir.d.ts for
// type info. Every test file that needs to spawn or import compiled output does a *value* import
// of this, not just a type import — `node --experimental-strip-types` (the runner `pnpm test`
// uses) resolves value imports between .ts files by their literal specifier, and does not, as of
// the Node version this repo targets, remap a ".js" specifier onto a sibling ".ts" file the way
// tsc's own NodeNext module resolution does at compile time. A real ".js" file here sidesteps
// that gap instead of requiring every test to special-case the extension.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// See dist-dir.d.ts for the rationale (PRAXARCH_TEST_DIST_DIR, defaulting to real dist/).
export const TEST_DIST_DIR = process.env["PRAXARCH_TEST_DIST_DIR"] ?? join(here, "..", "..", "dist");
