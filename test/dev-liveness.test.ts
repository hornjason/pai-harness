/**
 * #304 — the dev-server liveness probe had a consumer's route baked into it.
 *
 * `gates/gate-executor.ts` curled a literal `${apiBase}/api/admin/health`.
 * `apiBase` came from config; the path did not — it is a
 * DailyBriefDashboard endpoint. The probe only runs for a project that sets
 * `dev.apiBase`, and rungate sets no `dev` key at all, so DDB is the only
 * project that has ever reached the line. It worked for one consumer by
 * coincidence.
 *
 * The first consumer with a different health route is told its running
 * server is DOWN and to start it. A false FAIL naming the wrong cause is
 * worse than no check.
 *
 * ## No default path, and that is the interesting decision
 *
 * `dev.healthPath ?? "/health"` is the obvious shape and is wrong for the
 * same reason the hardcoded route was: a guessed path 404s on a healthy
 * server, `curl -sf` exits non-zero, and the probe reports DOWN. Unconfigured
 * has to mean UNMEASURED — recorded as a WARN, never as a FAIL — which is the
 * distinction #185 drew for `mergedIntoBase`, in the direction that matters.
 * Reporting DOWN looks fail-closed and is simply wrong.
 *
 * Covers SC-733, SC-734, SC-735, SC-736 of GATE-CONTRACTS-SPEC.md.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  livenessPlan,
  livenessUrl,
  hasServerDependentOutcomeAC,
} from "../lib/dev-liveness";
import { stripJsComments } from "../lib/strip-js-comments";

const ROOT = join(import.meta.dir, "..");

const outcomeAC = (type: string) => [{ type: "OUTCOME", evidenceMethod: { type } }];
const DDB = { apiBase: "http://localhost:7777", healthPath: "/api/admin/health", start: "make dev-all" };
const OTHER = { apiBase: "https://app.example.test", healthPath: "/healthz", start: "npm run dev" };

describe("#304: the probe applies only when something needs a server", () => {
  test("a run with no server-dependent AC is not-applicable", () => {
    const plan = livenessPlan([{ type: "CODE", evidenceMethod: { type: "BUN_TEST" } }], DDB);
    expect(plan.kind).toBe("not-applicable");
  });

  test("each server-dependent evidence type triggers it", () => {
    // Enumerated rather than spot-checked: this list is the trigger, and a
    // type quietly dropped from it silently disables the probe.
    for (const t of ["PLAYWRIGHT", "HTTP", "CURL", "SCREENSHOT"]) {
      expect(hasServerDependentOutcomeAC(outcomeAC(t)), `${t} did not trigger`).toBe(true);
      expect(hasServerDependentOutcomeAC(outcomeAC(t.toLowerCase())), `${t} lower-case`).toBe(true);
    }
  });

  test("a server-dependent evidence type on a non-OUTCOME AC does not trigger it", () => {
    expect(hasServerDependentOutcomeAC([{ type: "CODE", evidenceMethod: { type: "HTTP" } }])).toBe(false);
  });

  test("a malformed acs value is false, not a throw", () => {
    for (const v of [undefined, null, "acs", 7, {}]) {
      expect(hasServerDependentOutcomeAC(v as unknown)).toBe(false);
    }
  });
});

describe("#304: two consumers with different health routes both work", () => {
  // Point 2 of the issue's test plan. Today the second one fails, which is
  // the finding.
  test("DDB's route is probed, and it is read from config not from the source", () => {
    const plan = livenessPlan(outcomeAC("PLAYWRIGHT"), DDB);
    expect(plan.kind).toBe("probe");
    if (plan.kind === "probe") {
      expect(plan.url).toBe("http://localhost:7777/api/admin/health");
      expect(plan.startHint).toBe("make dev-all");
    }
  });

  test("a different consumer's route is probed, which is the whole issue", () => {
    const plan = livenessPlan(outcomeAC("HTTP"), OTHER);
    expect(plan.kind).toBe("probe");
    if (plan.kind === "probe") {
      expect(plan.url).toBe("https://app.example.test/healthz");
      expect(plan.startHint).toBe("npm run dev");
    }
  });

  test("the two produce different URLs — the assertion is not matching a constant", () => {
    const a = livenessPlan(outcomeAC("HTTP"), DDB);
    const b = livenessPlan(outcomeAC("HTTP"), OTHER);
    expect(a.kind === "probe" && b.kind === "probe" && a.url !== b.url).toBe(true);
  });
});

describe("#304: unconfigured means UNMEASURED, never DOWN", () => {
  test("no apiBase is unmeasured", () => {
    const plan = livenessPlan(outcomeAC("HTTP"), { healthPath: "/healthz" });
    expect(plan.kind).toBe("unmeasured");
    if (plan.kind !== "probe") expect(plan.detail).toContain("UNMEASURED");
  });

  test("no healthPath is unmeasured, and says why no path is guessed", () => {
    // The decision this issue turns on, asserted rather than left in a
    // comment: a default would 404 on a healthy server.
    const plan = livenessPlan(outcomeAC("HTTP"), { apiBase: "http://localhost:7777" });
    expect(plan.kind).toBe("unmeasured");
    if (plan.kind !== "probe") {
      expect(plan.detail).toContain("healthPath");
      expect(plan.detail, "the refusal does not explain why there is no default").toContain("guessed");
    }
  });

  test("no dev config at all is unmeasured, not not-applicable", () => {
    // These two differ: "nothing wanted a server" is silence, "something did
    // and we could not look" is a recorded gap.
    const plan = livenessPlan(outcomeAC("SCREENSHOT"), undefined);
    expect(plan.kind).toBe("unmeasured");
  });

  test("an unmeasured plan is never a probe — there is no fallback path", () => {
    // The regression this guards is somebody adding `?? "/health"` later.
    const plans = [
      livenessPlan(outcomeAC("HTTP"), { apiBase: "http://localhost:7777" }),
      livenessPlan(outcomeAC("HTTP"), {}),
      livenessPlan(outcomeAC("HTTP"), undefined),
    ];
    for (const p of plans) expect(p.kind).not.toBe("probe");
  });
});

describe("#304: the URL the probe is handed is bounded", () => {
  test("a non-http scheme is refused", () => {
    expect(livenessUrl("file:///etc/passwd", "/health")).toBeNull();
    expect(livenessUrl("ftp://host", "/health")).toBeNull();
  });

  test("a path that climbs out of the base origin is refused", () => {
    expect(livenessUrl("http://localhost:7777", "//evil.example/health")).toBeNull();
  });

  test("a relative path is refused — it must be rooted", () => {
    expect(livenessUrl("http://localhost:7777", "health")).toBeNull();
  });

  test("an unparseable base is refused rather than concatenated", () => {
    expect(livenessUrl("not a url", "/health")).toBeNull();
  });

  test("a legitimate path with a query string survives", () => {
    // Narrow, not scorched: the opposite failure is a validator that refuses
    // everything, which makes every consumer UNMEASURED.
    expect(livenessUrl("http://localhost:7777", "/api/health?deep=1"))
      .toBe("http://localhost:7777/api/health?deep=1");
  });

  test("a refused URL becomes unmeasured, not a probe of something else", () => {
    const plan = livenessPlan(outcomeAC("HTTP"), { apiBase: "file:///x", healthPath: "/health" });
    expect(plan.kind).toBe("unmeasured");
  });
});

describe("#304: no consumer route literal is left in the harness", () => {
  // Point 1 of the issue's test plan: the single fix leaves the class open,
  // and this is the cheap check that catches the next one.
  //
  // Scoped to ROUTE PATHS deliberately. A broader sweep for consumer-shaped
  // strings was written and measured first: it finds four more real instances
  // (`make rebuild` hardcoded in lib/transcript-checker.ts and in two agent
  // briefs, `make dev-all` as a scaffold default), and asserting on them here
  // would need an exemption list longer than the check. Those are #343; this
  // stays within what it can refuse cleanly.
  //
  // What this found that #304 did not name: the issue described ONE site.
  // There were five. Three in gates/gate-executor.ts — the liveness check,
  // plus the prove gate's dev probe behind a `process.exit(1)` and its prod
  // probe behind a warning — and two prompt-side, in workflows/. All five are
  // fixed except the two in `workflows/verify.js`, which are held below as a
  // counted ratchet rather than an exemption.
  const CLEAN = ["gates", "lib"];
  const DIRS = [...CLEAN, "workflows"];
  //
  // Bare, not quote-anchored. The first version required a quote on each side
  // and so did not match `` `curl -sf ${apiBase}/api/admin/health` `` — the
  // literal this issue is about, which is preceded by `}`. A detector that
  // cannot see the instance it was written for is this repo's house defect,
  // and the planted control below is the only reason it was noticed before
  // the absence claim went green over three live occurrences.
  const ROUTE = /\/api\/[a-z0-9][a-z0-9/_.-]*/gi;

  function sources(roots: string[] = DIRS): Array<{ file: string; code: string }> {
    const out: Array<{ file: string; code: string }> = [];
    const walk = (dir: string, rel: string) => {
      for (const e of require("fs").readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (["node_modules", "test-fixtures"].includes(e.name)) continue;
          walk(join(dir, e.name), r);
        } else if (/\.(ts|js)$/.test(e.name) && !e.name.endsWith(".test.ts")) {
          // Comments stripped. This module's own docblock quotes the route it
          // exists to have removed, and the first run of this test reported
          // it — the self-reference trap, in the detector written for it.
          out.push({ file: r.slice(1), code: stripJsComments(readFileSync(join(ROOT, dir, e.name), "utf-8")) });
        }
      }
    };
    for (const d of roots) walk(d, `/${d}`);
    return out;
  }

  const routesIn = (roots: string[]) => {
    const found: string[] = [];
    for (const { file, code } of sources(roots)) {
      for (const m of code.matchAll(ROUTE)) found.push(`${file}: ${m[0]}`);
    }
    return found;
  };

  test("the sweep reads real files — it is not scanning an empty list", () => {
    const files = sources();
    expect(files.length, "no harness sources found").toBeGreaterThan(20);
    expect(files.some(f => f.file.includes("gate-executor"))).toBe(true);
  });

  test("no API route path is written into gates/ or lib/", () => {
    const offenders = routesIn(CLEAN);
    expect(
      offenders,
      `consumer API route(s) hardcoded in the harness: ${offenders.join(", ")}. A route belongs ` +
        `in the consumer's rungate.json, not in gates/ or lib/ — a gate that only works on the ` +
        `project it was written against is that project's script (#304).`,
    ).toEqual([]);
  });

  test("workflows/ holds exactly its two known routes — a ratchet, not an exemption", () => {
    // `workflows/verify.js` smoke-tests two DailyBriefDashboard endpoints by
    // name, and they are the smallest part of its problem: it also hardcodes
    // DDB's ports (`ENV === 'prod' ? '7777' : '7776'`), its container name
    // (`pai-dashboard`) and its in-container app path. Making it config-driven
    // is #344, not #304.
    //
    // Held as an exact count rather than a skipped directory. A directory left
    // out of the sweep is a directory nobody measures again; a count refuses
    // growth, and goes red as an instruction to DELIST when #344 lands rather
    // than quietly tolerating the debt forever.
    const found = routesIn(["workflows"]).sort();
    expect(
      found,
      `workflows/ route literals changed. If you FIXED one, delete it from this list — the ` +
        `ratchet has to move both ways or it becomes a permanent licence (#304, #344).`,
    ).toEqual([
      "workflows/verify.js: /api/action-triggers",
      "workflows/verify.js: /api/aes",
    ]);
  });

  test("the sweep would catch one — planted control", () => {
    // The absence claim above passes trivially now that the lines are gone.
    // This plants the literal that actually shipped, in the form it shipped
    // in — inside a template, preceded by `}` rather than by a quote. The
    // first version of the pattern required quotes on both sides and scored
    // this 0, which is the same defect the issue is about: a detector that
    // cannot see the instance it was written for.
    const planted = 'execSync(`curl -sf ${apiBase}/api/admin/health`);';
    expect([...stripJsComments(planted).matchAll(ROUTE)].length).toBe(1);
  });

  test("the sweep ignores a route inside a comment", () => {
    // The other half. Without stripping, this file's own docblock and the
    // explanations in lib/dev-liveness.ts would be reported — the detector
    // flagging the prose that describes what it detects.
    expect([...stripJsComments("// see /api/admin/health\nconst x = 1;").matchAll(ROUTE)].length).toBe(0);
  });

  test("the call site reads the path from config", () => {
    const code = stripJsComments(readFileSync(join(ROOT, "gates", "gate-executor.ts"), "utf-8"));
    expect(code).toContain("livenessPlan(state.acs");
    expect(code, "the probe still goes through a shell").not.toMatch(/execSync\(`curl/);
    expect(code).toMatch(/execFileSync\("curl"/);
  });

  test("dev.healthPath is a declared key, so a consumer can set it", () => {
    // Without this the fix is a config read of a field the validator strips —
    // which is #307 SC-A1 exactly, reintroduced.
    //
    // Bounded to DevSchema's own object literal. The first version of this
    // sliced from `DevSchema` to `ContainerSchema`, which spans TestSchema
    // too — and the key had in fact been added to the wrong schema, so it
    // passed while `dev.healthPath` was still undeclared. A detector wider
    // than its subject is the same defect as one narrower than it.
    const schema = stripJsComments(readFileSync(join(ROOT, "lib", "rungate-schema.ts"), "utf-8"));
    const start = schema.indexOf("export const DevSchema");
    expect(start, "DevSchema is not declared where this expects").toBeGreaterThan(-1);
    const dev = schema.slice(start, schema.indexOf("});", start));
    expect(dev).toContain("healthPath");
    expect(dev, "the slice ran past DevSchema's literal").not.toContain("TestSchema");
  });

  test("the schema slice would notice its absence — planted control", () => {
    // The assertion above is a presence claim over a slice whose bounds are
    // computed, which is exactly the shape that passes by accident.
    const fake = "export const DevSchema = z.object({\n  start: z.string(),\n});\n";
    const dev = fake.slice(fake.indexOf("export const DevSchema"), fake.indexOf("});"));
    expect(dev).not.toContain("healthPath");
  });
});
