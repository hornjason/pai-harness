import { resolve } from "path";
import { runScaffoldConformity } from "../lib/conformity";

const ROOT = resolve(import.meta.dir, "..");
runScaffoldConformity(ROOT);
