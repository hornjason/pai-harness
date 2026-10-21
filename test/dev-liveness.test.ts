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
 * Covers SC-733, SC-734, SC-735, SC-736, SC-738, SC-739, SC-740, SC-741,
 * SC-742 of GATE-CONTRACTS-SPEC.md.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  livenessPlan,
  livenessUrl,
  probeTarget,
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
    expect(livenessUrl("http://localhost:7777/base", "/../../elsewhere")).toBeNull();
  });

  test("a base path is kept, not discarded", () => {
    // Security review of the first version of this fix. `new URL("/health",
    // "http://host/base/api")` yields `http://host/health` — the prefix is
    // silently dropped, so a consumer whose API is mounted under one is
    // probed at the wrong place and reported DOWN on a healthy server. That
    // is this issue's own bug, reintroduced by URL resolution semantics.
    expect(livenessUrl("http://localhost:7777/base/api", "/health"))
      .toBe("http://localhost:7777/base/api/health");
    expect(livenessUrl("http://localhost:7777/base/", "/health"))
      .toBe("http://localhost:7777/base/health");
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

describe("#304: credentials in apiBase never reach a durable artefact", () => {
  // Security review. `detail` and the printed URL land in ship-evidence.json,
  // which is attached to issues — the same leak #213 found in push `detail`,
  // which is why redactSecrets is imported rather than written a second time.
  const CREDS = "http://jhorn:hunter2@localhost:7777";

  test("the probe URL keeps the credentials — curl still needs them", () => {
    const t = probeTarget("dev", { apiBase: CREDS, healthPath: "/healthz" });
    expect(t.kind).toBe("probe");
    if (t.kind === "probe") expect(t.url).toContain("hunter2");
  });

  test("the recordable URL does not", () => {
    const t = probeTarget("dev", { apiBase: CREDS, healthPath: "/healthz" });
    if (t.kind === "probe") {
      expect(t.safeUrl).not.toContain("hunter2");
      expect(t.safeUrl).not.toContain("jhorn");
      expect(t.safeUrl, "redaction ate the host too").toContain("localhost:7777/healthz");
    }
  });

  test("an unmeasured detail naming apiBase is redacted", () => {
    // The branch that leaked: no healthPath, so the detail quotes apiBase
    // verbatim to say where it would have looked.
    const t = probeTarget("dev", { apiBase: CREDS });
    expect(t.kind).toBe("unmeasured");
    if (t.kind === "unmeasured") {
      expect(t.detail).not.toContain("hunter2");
      expect(t.detail).toContain("<redacted>");
    }
  });

  test("a bare token in apiBase is redacted too", () => {
    // Constructed, not spelled (#1036). One binding, so the URL and the
    // assertion cannot drift apart into testing different strings.
    const token = "ghp_" + "abcdefghij1234567890";
    const t = probeTarget("dev", { apiBase: `http://localhost:7777/${token}` });
    if (t.kind === "unmeasured") expect(t.detail).not.toContain(token);
  });

  test("a credential in the QUERY STRING is redacted", () => {
    // Second security round. `redactSecrets` covers userinfo and bare GitHub
    // tokens and does not touch a query string — and a health route is
    // exactly where a consumer puts `?access_token=…`. The first version of
    // this fix redacted the one form it had been shown and shipped the other.
    const t = probeTarget("dev", {
      apiBase: "http://localhost:7777",
      healthPath: "/health?access_token=s3cr3tvalue&deep=1",
    });
    expect(t.kind).toBe("probe");
    if (t.kind === "probe") {
      expect(t.url, "curl must still get the real query").toContain("s3cr3tvalue");
      expect(t.safeUrl).not.toContain("s3cr3tvalue");
      expect(t.safeUrl, "the path is needed to identify the probe").toContain("/health");
    }
  });

  test("every query value goes, not a list of suspicious key names", () => {
    // A key allowlist is a detector narrower than what it detects: it needs
    // updating for the next consumer's naming and nothing goes red when it
    // is not. `deep=1` is harmless and still blanked, on purpose.
    const t = probeTarget("dev", {
      apiBase: "http://localhost:7777",
      healthPath: "/health?zzz=abc&q=def",
    });
    if (t.kind === "probe") {
      expect(t.safeUrl).not.toContain("abc");
      expect(t.safeUrl).not.toContain("def");
      expect(t.safeUrl).toContain("<redacted>");
    }
  });

  test("an unmeasured detail quoting healthPath is redacted too", () => {
    // The other leak site: the "these do not combine" branch quotes the path
    // verbatim to explain what it could not use.
    const t = probeTarget("dev", { apiBase: "ftp://x", healthPath: "/health?api_key=leakme123" });
    expect(t.kind).toBe("unmeasured");
    if (t.kind === "unmeasured") expect(t.detail).not.toContain("leakme123");
  });

  test("the gate prints safeUrl, never url", () => {
    // The library can redact perfectly and the call site can print the other
    // field. Three print sites and one recorded detail, all asserted.
    const code = stripJsComments(readFileSync(join(ROOT, "gates", "gate-executor.ts"), "utf-8"));
    const liveness = code.slice(code.indexOf("function checkDevServerLiveness"));
    const body = liveness.slice(0, liveness.indexOf("\nfunction "));
    expect(body, "a raw probe URL is printed or recorded").not.toMatch(/\$\{plan\.url\}/);
    expect(body).toMatch(/\$\{plan\.safeUrl\}/);
  });
});

describe("#304: relaxing a refusal is recorded, not evaporated", () => {
  // Security review, second finding. The prove gate used to `process.exit(1)`
  // when `dev.apiBase` was set and the server did not answer. No consumer
  // sets `dev.healthPath` yet, so on merge every one of them stops being
  // refused there. Reporting DOWN instead would be wrong — that is the whole
  // issue — but a relaxation that leaves only a stdout line is a fail-open.
  const code = stripJsComments(readFileSync(join(ROOT, "gates", "gate-executor.ts"), "utf-8"));

  test("the prove gate carries its liveness readings into prove-input.json", () => {
    expect(code).toMatch(/liveness: \[devLiveness, prodLiveness\]\.filter\(Boolean\)/);
  });

  test("and onto the workflow state, which is what later gates read", () => {
    // Second security round. prove-input.json is consumed by one spawned
    // agent and discarded; writing only there leaves the record as ephemeral
    // as the stdout line it replaced.
    expect(code).toMatch(/state\.liveness = proveInput\.liveness/);
    expect(code).toMatch(/writeFileSync\(stateFile, JSON\.stringify\(state/);
  });

  test("the gap is named in the source, not just in an issue", () => {
    // The record is written and no check refuses on it (#346). A reader of
    // this function has to be able to see that, or the next person treats a
    // passing prove gate as evidence liveness was measured.
    //
    // Read RAW, not comment-stripped: the note lives in a comment, which is
    // the one thing `code` has removed. The first version of this assertion
    // searched the stripped text for a string that can only appear in a
    // comment, and failed for a reason that had nothing to do with the note
    // being absent.
    const raw = readFileSync(join(ROOT, "gates", "gate-executor.ts"), "utf-8");
    const relaxation = raw.slice(raw.indexOf("REFUSAL RELAXATION"));
    expect(
      relaxation.slice(0, relaxation.indexOf("const proveInput")),
      "#346 is not referenced where the relaxation lives",
    ).toContain("#346");
  });

  test("the retracted claim is not still in the tree", () => {
    // An earlier draft asserted the B3 reproducer reads this field. It does
    // not — gates/prompts/prove-reproducer.md never mentions liveness — and
    // the claim was written without checking. Asserted so it cannot come
    // back as a comment nobody re-verifies.
    // RAW again, for the same reason as the test above, and it took a
    // mutation scoring 0 red to notice: the first version searched `code`,
    // which is comment-stripped, for a sentence that can only ever appear in
    // a comment. Replanting the claim verbatim left it green. That is a
    // check that passed because of what it never looked at, written twice in
    // a row inside the file whose subject is that defect.
    const prompt = readFileSync(join(ROOT, "gates", "prompts", "prove-reproducer.md"), "utf-8");
    const reproducerReadsIt = /liveness/i.test(prompt);
    expect(reproducerReadsIt, "the prompt now reads liveness — delete this guard").toBe(false);

    const raw = readFileSync(join(ROOT, "gates", "gate-executor.ts"), "utf-8");
    const claims = [...raw.matchAll(/B3 reproducer reads (?:them|it|the field)/g)]
      .filter(m => !raw.slice(m.index!, m.index! + 120).includes("It does not"));
    expect(
      claims.map(m => raw.slice(m.index!, m.index! + 60)),
      "the source claims the B3 reproducer reads the liveness field. It does not — " +
        "gates/prompts/prove-reproducer.md never mentions liveness (#346).",
    ).toEqual([]);
  });

  test("the UNMEASURED branch records before it warns", () => {
    // A `console.warn` with no assignment beside it is the shape that was
    // flagged. Both tiers.
    expect(code).toMatch(/devLiveness = \{ tier: "dev", status: "UNMEASURED"/);
    expect(code).toMatch(/prodLiveness = \{ tier: "prod", status: "UNMEASURED"/);
  });

  test("prod DOWN and prod UNMEASURED are distinct recorded states", () => {
    // The distinction the record exists to preserve: DOWN means the probe
    // ran, UNMEASURED means it could not. Collapsing them is what makes an
    // unmeasured gate look checked.
    expect(code).toMatch(/prodLiveness = \{ tier: "prod", status: "DOWN"/);
    expect(code).toMatch(/prodLiveness = \{ tier: "prod", status: "UP"/);
  });

  test("dev still refuses when it CAN measure — the relaxation is scoped", () => {
    // Paired control. A change that simply deleted the refusal would satisfy
    // every assertion above.
    const dev = code.slice(code.indexOf("const devTarget = probeTarget"));
    expect(dev.slice(0, dev.indexOf("prodLiveness"))).toContain("process.exit(1)");
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
  // fixed; the last two went in #344.
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

  test("workflows/ holds no route literals either — the ratchet is now empty", () => {
    // This shipped holding two: `workflows/verify.js` smoke-tested two of one
    // consumer's endpoints by name, alongside that consumer's ports, container
    // name, app root and test directory. #344 fixed all of it, and the list
    // went red on the next run demanding to be emptied.
    //
    // That is the ratchet working in the direction ratchets usually do not.
    // A skipped directory would have stayed skipped; a count had to be
    // changed, by someone reading why it was there.
    const found = routesIn(["workflows"]).sort();
    expect(
      found,
      `workflows/ route literals changed. If you FIXED one, delete it from this list — the ` +
        `ratchet has to move both ways or it becomes a permanent licence (#304, #344).`,
    ).toEqual([]);
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
