import { resolve } from "path";
import { runScaffoldConformity, runDocHygiene, runFallowCheck, runAgentFileValidation } from "../lib/conformity";

const ROOT = resolve(import.meta.dir, "..");
runScaffoldConformity(ROOT);
runDocHygiene(ROOT);
runFallowCheck(ROOT);
runAgentFileValidation(ROOT);
