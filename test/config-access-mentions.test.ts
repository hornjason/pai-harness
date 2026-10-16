/**
 * Covers SC-1550..SC-1559 (CONFIG-DIRECTORY-STRUCTURE-SPEC.md), #415.
 *
 * CONFIG-1 counted a config path MENTIONED in a sentence the same way it
 * counted one PASSED TO `readFileSync`. Seven of the banked sites — and, once
 * measured, twenty-two — were documentation, operator messages and generated
 * file content. None of them could ever reach zero by migrating a read,
 * because there was no read: the cheapest way to clear them was to reword a
 * user-facing string so it stopped naming the file it was telling the operator
 * to edit. That is the detector driving the code rather than measuring it, and
 * `.claude/rules/checks-must-be-able-to-fail.md` calls the general shape "a
 * detector narrower than what it detects" — this is the same defect inverted,
 * a detector WIDER than what it detects.
 *
 * The direction this file guards is the dangerous one. Narrowing a detector is
 * the change most likely to buy green with blindness, so every assertion below
 * is two-sided: a mention must not be counted AND a real read must still be,
 * in the same fixture, read by the same scan.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  scanConfigAccess,
  scanPromptConfigAccess,
  classifyConfigSites,
  readConfigAccessRatchet,
  configAccessViolations,
} from "../lib/conformity";
import { loadRoleConfig } from "../lib/config-readers";
import { resolveConfig } from "../lib/config-loader";

const REPO = join(import.meta.dir, "..");

/** The two halves of the path, never adjacent in this file's own source. */
const DOT_DIR = ".clau" + "de";
const CFG = "run" + "gate";
const MONOLITH = `${DOT_DIR}/${CFG}.json`;
const DIR_CONFIG = `${DOT_DIR}/${CFG}/config.json`;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "rg-415-"));
}

function writeSource(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

/**
 * One file carrying both shapes, so neither assertion can hold vacuously:
 * whatever the scan does to the mention it does to the read in the same pass.
 */
const BOTH_SHAPES = [
  `import { readFileSync, existsSync } from "fs";`,
  `import { execSync } from "child_process";`,
  `import { join } from "path";`,
  ``,
  `const notes: string[] = [];`,
  `notes.push("not configured — check ${DIR_CONFIG}");`,
  `export const customize = "Set \`ci\` fields in \`${DIR_CONFIG}\`; add your own jobs";`,
  `notes.push({ file: "${DOT_DIR}/${CFG}/" } as unknown as string);`,
  `console.error("expected ${DIR_CONFIG} or ${MONOLITH}");`,
  ``,
  `export function read(root: string): string | null {`,
  `  const p = join(root, "${DOT_DIR}", "${CFG}.json");`,
  `  return existsSync(p) ? readFileSync(p, "utf-8") : null;`,
  `}`,
  ``,
  `export function viaShell(): string {`,
  `  return execSync("cat ${MONOLITH} | head -20").toString();`,
  `}`,
].join("\n");

describe("#415 — a config path mentioned is not a config path read", () => {
  test("SC-1550: only the path handed to an fs call is counted a violation", () => {
    const root = scratch();
    try {
      writeSource(root, "lib/both.ts", BOTH_SHAPES);
      const scan = scanConfigAccess(root);

      // Both reads are counted — the `join` and the shell command. The
      // second matters because its literal is a SENTENCE: `cat <root>/…json`
      // has spaces in it, so the prose rule alone would have waved it
      // through, and a config read down a shell is still a config read.
      // Pinned to literals rather than to the classifier's own answer — a
      // count compared against the thing that produced it cannot disagree.
      expect(scan.counts["lib/both.ts"]).toBe(2);
      expect(scan.filesScanned).toBe(1);

      // And the scan did look at all five mention sites: the raw matches are
      // seven, so "2" is a decision and not a scan that read less of the file.
      const sites = classifyConfigSites(readFileSync(join(root, "lib/both.ts"), "utf-8"));
      expect(sites.length).toBe(7);
      expect(sites.filter((s) => s.kind === "use").length).toBe(2);
      expect(sites.filter((s) => s.kind === "mention").length).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SC-1551: a path-shaped literal with no fs call behind it still counts", () => {
    const root = scratch();
    try {
      // The fail-open this classifier could have shipped: a bare path literal
      // assigned to a name, read a line later. No enclosing call to recognise,
      // and nothing prose-like about the string. It must COUNT.
      writeSource(
        root,
        "lib/bare.ts",
        [
          `import { readFileSync } from "fs";`,
          `const target = "${MONOLITH}";`,
          `export const body = readFileSync(target, "utf-8");`,
        ].join("\n"),
      );
      expect(scanConfigAccess(root).counts["lib/bare.ts"]).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SC-1552: CHECK-2 still counts a prompt that tells an agent to read the config", () => {
    const root = scratch();
    try {
      const prose = `Read \${PROJECT_ROOT}/${MONOLITH} for environment config.`;
      writeSource(root, "lib/only-prose.ts", `export const help = "${prose}";`);
      mkdirSync(join(root, "workflows"), { recursive: true });
      writeFileSync(join(root, "workflows", "ship.js"), "const prompt = `" + prose + "`\n");

      // Same sentence, two checks, two answers — and that is the point.
      // CHECK-1's subject is a path being built in code; CHECK-2's subject is
      // the prompt text itself, where prose IS the violation. Collapsing them
      // onto one classifier would silently empty CHECK-2.
      expect(scanConfigAccess(root).counts["lib/only-prose.ts"]).toBeUndefined();
      expect(scanPromptConfigAccess(root).counts["workflows/ship.js"]).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SC-1553: both branches are load-bearing on real source, not only on a fixture", () => {
    // `lib/scaffold/steps.ts` is the one production file that carries both
    // kinds. If the classifier collapsed in either direction its banked number
    // would move, and the both-ways ratchet would refuse — which is what makes
    // the mutation in the spec table reach something.
    const steps = readFileSync(join(REPO, "lib/scaffold/steps.ts"), "utf-8");
    const sites = classifyConfigSites(steps);
    const uses = sites.filter((s) => s.kind === "use").length;
    const mentions = sites.filter((s) => s.kind === "mention").length;

    expect(uses).toBeGreaterThan(0);
    expect(mentions).toBeGreaterThan(0);
    expect(readConfigAccessRatchet(REPO, "sources")["lib/scaffold/steps.ts"]).toBe(uses);
  });

  test("SC-1554: the documentation and writer sites are gone from the ratchet", () => {
    const banked = readConfigAccessRatchet(REPO, "sources");
    for (const cleared of [
      "lib/generators/agent-briefs.ts",
      "lib/scaffold/owned-files.ts",
      "lib/scanner.ts",
      "scripts/resolve-config.ts",
      "scripts/create-brief.ts",
      "scripts/scaffold-rungate-config.ts",
    ]) {
      expect(banked[cleared]).toBeUndefined();
    }

    // And the repo is clean under the real check, in both directions — an
    // entry banked above what remains fails exactly as a new reader does.
    const violations = configAccessViolations(
      scanConfigAccess(REPO),
      readConfigAccessRatchet(REPO, "sources"),
      "CONFIG-1",
    );
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

describe("#415 — a role is registered in the layout the project is on", () => {
  function run(root: string): { code: number; out: string } {
    mkdirSync(join(root, "templates", "agent-briefs"), { recursive: true });
    const proc = Bun.spawnSync({
      cmd: [
        "bun",
        join(REPO, "scripts/create-brief.ts"),
        "tester",
        "Test engineer who verifies changes",
        "--project-root",
        root,
      ],
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: proc.exitCode ?? -1,
      out: proc.stdout.toString() + proc.stderr.toString(),
    };
  }

  test("SC-1555: a directory-layout project gets the role, and the loader reads it back", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, DOT_DIR, CFG), { recursive: true });
      writeFileSync(
        join(root, DOT_DIR, CFG, "config.json"),
        JSON.stringify({ description: "fixture" }, null, 2) + "\n",
      );
      writeFileSync(join(root, DOT_DIR, CFG, "roles.json"), JSON.stringify({}, null, 2) + "\n");

      const { code, out } = run(root);
      expect(code, out).toBe(0);
      expect(out).not.toMatch(/not registered/);

      // Read back through the accessor a consumer would use, not through the
      // file the writer happened to pick.
      const roles = loadRoleConfig(root);
      expect(Object.keys(roles)).toContain("tester");
      expect(roles.tester?.description).toBe("Test engineer who verifies changes");

      // The monolith was NOT created as a side effect — a writer that invents
      // the old layout alongside the new one gives the project two role sets.
      expect(existsSync(join(root, `${CFG}.json`))).toBe(false);
      expect(existsSync(join(root, DOT_DIR, `${CFG}.json`))).toBe(false);
      expect(resolveConfig(root).status).toBe("resolved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SC-1556: a monolith project still gets the role, in the monolith", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, DOT_DIR), { recursive: true });
      writeFileSync(
        join(root, DOT_DIR, `${CFG}.json`),
        JSON.stringify({ description: "fixture", roles: {} }, null, 2) + "\n",
      );

      const { code, out } = run(root);
      expect(code, out).toBe(0);

      const roles = loadRoleConfig(root);
      expect(Object.keys(roles)).toContain("tester");

      // Both layouts answered from the same authored description, compared to
      // each other rather than to whichever file the writer chose.
      const onDisk = JSON.parse(readFileSync(join(root, DOT_DIR, `${CFG}.json`), "utf-8"));
      expect(onDisk.roles.tester.description).toBe(roles.tester?.description);
      expect(existsSync(join(root, DOT_DIR, CFG, "roles.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SC-1558: the scaffolder refuses a project that already has a config", () => {
    const root = scratch();
    try {
      const scaffold = () =>
        Bun.spawnSync({
          cmd: ["bun", join(REPO, "scripts/scaffold-rungate-config.ts"), root],
          cwd: REPO,
          stdout: "pipe",
          stderr: "pipe",
        });

      // A project with something to detect, so "the loader read it" is not
      // satisfied by a config that is almost empty.
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ scripts: { dev: "vite", test: "bun test" } }, null, 2),
      );

      const first = scaffold();
      expect(first.exitCode, first.stderr.toString()).toBe(0);
      const written = readFileSync(join(root, DOT_DIR, CFG, "config.json"), "utf-8");

      // What the scaffolder writes, the loader must be able to read — and the
      // detected commands must survive it. Both halves had been false: an
      // undetected command was written as `null`, which fails validation, and
      // the detected one went to a key DevSchema does not declare, so the
      // loader dropped it. Neither was visible while this script never asked
      // the loader to read its own output.
      const resolved = resolveConfig(root);
      expect(resolved.status).toBe("resolved");
      if (resolved.status === "resolved") {
        expect(resolved.config.dev?.start).toBe("npm run dev");
        expect(resolved.config.test?.command).toBe("bun test --timeout 30000");
      }

      // Now AUTHOR something, the way an operator would. Comparing the bytes
      // of an untouched config across two runs proves nothing — the second
      // run would rewrite them identically, so a scaffolder that had stopped
      // refusing would pass. The edit is what makes the refusal observable.
      const authored = JSON.parse(written);
      authored.issueRepo = "example-owner/example-project";
      writeFileSync(
        join(root, DOT_DIR, CFG, "config.json"),
        JSON.stringify(authored, null, 2) + "\n",
      );
      const mine = readFileSync(join(root, DOT_DIR, CFG, "config.json"), "utf-8");

      const second = scaffold();
      expect(second.exitCode).toBe(0);
      expect(second.stdout.toString()).toMatch(/EXISTS:/);
      expect(readFileSync(join(root, DOT_DIR, CFG, "config.json"), "utf-8")).toBe(mine);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SC-1559: a project with nothing to detect still writes a readable config", () => {
    // The control arm for SC-1558, and the one that actually bit: with a
    // package.json present every command is inferred and no `null` is ever
    // written, so a fixture that plants one cannot see the defect. A bare
    // directory infers nothing, and that is exactly the project whose config
    // the loader could not parse.
    const root = scratch();
    try {
      const proc = Bun.spawnSync({
        cmd: ["bun", join(REPO, "scripts/scaffold-rungate-config.ts"), root],
        cwd: REPO,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);

      const resolved = resolveConfig(root);
      expect(resolved.status).toBe("resolved");
      if (resolved.status === "resolved") {
        // Absent, not null and not a substituted default — `0`, `{}`, `null`
        // and `SKIP` are indistinguishable from success, per
        // `.claude/rules/config-access.md`.
        expect(resolved.config.dev?.start).toBeUndefined();
        expect(resolved.config.prod?.rebuild).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SC-1557: an unscaffolded project is told so, and nothing is invented", () => {
    const root = scratch();
    try {
      const { code, out } = run(root);
      expect(code, out).toBe(0);
      // UNMEASURED, not SKIP: the message has to name the absence rather than
      // naming a file the project is documented not to have.
      expect(out).toMatch(/no rungate config/i);
      expect(existsSync(join(root, DOT_DIR, `${CFG}.json`))).toBe(false);
      expect(existsSync(join(root, DOT_DIR, CFG))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
