import { resolve } from "path";
import { runSpecDrift } from "../lib/conformity";

// DRIFT-2's ratchet list lives in .claude/conformity-allowlists.json, read per
// project root. It is deliberately not inlined here or in lib/conformity.ts:
// the equivalent consumer test is harness-managed and regenerated, and a list
// in lib/ would exempt consumer specs by filename collision (#80 follow-up).
const ROOT = resolve(import.meta.dir, "..");
runSpecDrift(ROOT);
