import { resolve } from "path";
import { runScaffoldConformity, runDocHygiene } from "../lib/conformity";

const ROOT = resolve(import.meta.dir, "..");
runScaffoldConformity(ROOT);
runDocHygiene(ROOT);
