import { resolve } from "path";
import { runSpecDrift } from "../lib/conformity";

const ROOT = resolve(import.meta.dir, "..");
runSpecDrift(ROOT);
