import { resolve } from "path";
import { runScaffoldConformity, runDocHygiene, runFallowCheck, runAgentFileValidation, runDirectoryValidation } from "../lib/conformity";

const ROOT = resolve(import.meta.dir, "..");
runScaffoldConformity(ROOT);
runDocHygiene(ROOT);
runFallowCheck(ROOT);
runAgentFileValidation(ROOT);
runDirectoryValidation(ROOT);
