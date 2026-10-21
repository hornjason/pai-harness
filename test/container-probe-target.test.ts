/**
 * #312 SC-A15, harness half — SC-2480..SC-2487 (CONFIG-DIRECTORY-STRUCTURE-SPEC.md).
 *
 * SC-A15 itself adds `container` config to a **consumer** repository. That is
 * a change in another repo and cannot ride a branch here, so what is tested
 * here is the half that lives in this one: what the harness does the moment a
 * `container` key survives load.
 *
 * It never has. `ProjectHarnessSchema` did not declare `container`, so the
 * validator deleted it and both sites in `workflows/ship.js` that read it took
 * their no-container arm on every run that has ever happened. #307 SC-A1
 * declared it. So these branches are reachable for the first time, and the
 * first consumer to take them gets, from the Ship phase's record-env step:
 *
 *     curl -s -o /dev/null -w "%{http_code}" http://undefined:3000/
 *
 * from `(containerConfig.hosts || [])[0]` and `containerConfig.port || 3000`,
 * for a config as ordinary as `{"container": {"rebuildCommand": "..."}}` —
 * which validates, because every field of `ContainerSchema` is optional. No
 * 200 comes back, so the step takes its "container is down" branch and writes
 * `prod.smoke = SKIP` with `smokeSkipReason = test container not running`.
 * Nothing contacted the container. A declared container with nowhere to reach
 * it and a probed container that was down produce the identical record, and
 * the first of those is a run that measured nothing reading like one that did.
 *
 * `lib/dev-liveness.ts` already decided this question for the `dev` and `prod`
 * tiers, once, on the argument that "unconfigured has to mean UNMEASURED"
 * (SC-733, #304). The container is the third tier and is the one that never
 * went through `probeTarget`. `containerProbeTarget` is that function for it.
 *
 * ship.js cannot import — the Workflow sandbox has no module loading, and a
 * top-level require() killed every ship run in ~11ms (#69) — so the copy in
 * its CONTAINER-PROBE block is run here against the library over the same
 * matrix, the pattern test/workflow-security-integration.test.ts established.
 *
 * The record-env arms are EXECUTED, not read. Every source-text assertion in
 * this repo has survived its first mutation, and #312's own SC-A13 is the
 * worked example: four green tests over a command that could never run,
 * because all four asserted on the sentence describing it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { containerProbeTarget, CONTAINER_HOST } from "../lib/dev-liveness";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

function sliceBlock(name: string): string {
  const a = shipSource.indexOf(`// ──── ${name}-START ────`);
  const b = shipSource.indexOf(`// ──── ${name}-END ────`);
  expect(a, `ship.js is missing the ${name}-START marker`).toBeGreaterThan(-1);
  expect(b, `ship.js is missing the ${name}-END marker`).toBeGreaterThan(a);
  // Exactly once each: a second copy would survive any mutation of the first.
  expect(shipSource.indexOf(`// ──── ${name}-START ────`, a + 1)).toBe(-1);
  expect(shipSource.indexOf(`// ──── ${name}-END ────`, b + 1)).toBe(-1);
  return shipSource.slice(a, b);
}

type Probe =
  | { kind: "unconfigured"; detail: string }
  | { kind: "unmeasured"; detail: string }
  | { kind: "probe"; host: string; port: number; healthPath: string; url: string; safeUrl: string };

const inlined = new Function(
  `${sliceBlock("CONTAINER-PROBE")}
   return { containerProbeTarget, CONTAINER_HOST };`,
)() as {
  containerProbeTarget: (c: unknown) => Probe;
  CONTAINER_HOST: RegExp;
};

/**
 * Every shape a `container` key can arrive in, including the ones
 * `ContainerSchema` permits and no consumer has written yet.
 *
 * Driven through BOTH implementations. A case list that only covered the
 * shapes I expected would be the narrower-detector shape again: the whole
 * reason this defect exists is that `hosts` being absent was not a shape
 * anybody had in mind when the `|| 3000` was written.
 */
const CASES: unknown[] = [
  null,
  undefined,
  {},
  "container",
  7776,
  { rebuildCommand: "make test-rebuild" },
  { port: 7776 },
  { hosts: [] },
  { hosts: ["localhost"] },
  { hosts: ["localhost"], port: 7776 },
  { hosts: ["localhost"], port: 7776, healthPath: "/health" },
  { hosts: ["localhost"], port: 7776, healthPath: "" },
  { hosts: ["localhost"], port: 7776, healthPath: null },
  { hosts: ["localhost"], port: 7776, healthPath: "health" },
  { hosts: ["localhost"], port: 7776, healthPath: "//evil.example.com/" },
  { hosts: ["localhost"], port: 7776, healthPath: "/h?token=ghp_abcdefghij1234567890" },
  { hosts: ["localhost"], port: 7776, healthPath: 7 },
  { hosts: ["localhost"], port: "7776" },
  { hosts: ["localhost"], port: 0 },
  { hosts: ["localhost"], port: -1 },
  { hosts: ["localhost"], port: 65536 },
  { hosts: ["localhost"], port: 7776.5 },
  { hosts: ["localhost"], port: NaN },
  { hosts: [""], port: 7776 },
  { hosts: [null, "mini.local"], port: 7776 },
  { hosts: ["a;rm -rf /"], port: 7776 },
  { hosts: ["$(id)"], port: 7776 },
  { hosts: ["a b"], port: 7776 },
  { hosts: ["bad host", "mini.local"], port: 7776 },
  { hosts: ["127.0.0.1"], port: 7776 },
  { hosts: "localhost", port: 7776 },
];

describe("#312 — the container is the third probe tier", () => {
  test("SC-2480: ship.js's inlined copy and the library agree on every case", () => {
    // The two cannot be the same object: ship.js runs in a sandbox with no
    // module loading. So the only thing that can hold them together is
    // running both, which is what test/workflow-security-integration.test.ts
    // does for the shell-safety primitives.
    for (const c of CASES) {
      expect(inlined.containerProbeTarget(c), `diverged on ${JSON.stringify(c)}`)
        .toEqual(containerProbeTarget(c as never) as unknown as Probe);
    }
    expect(inlined.CONTAINER_HOST.source).toBe(CONTAINER_HOST.source);
    // The positive control for the matrix: if every case came back
    // `unconfigured`, each assertion above would pass over a pair of
    // functions that had both stopped working.
    const kinds = new Set(CASES.map(c => containerProbeTarget(c as never).kind));
    expect(kinds).toEqual(new Set(["unconfigured", "unmeasured", "probe"]));
  });

  test("SC-2481: a container with nowhere to reach it is UNMEASURED, not a probe", () => {
    // The exact config that produced `http://undefined:3000/`.
    const r = containerProbeTarget({ rebuildCommand: "make test-rebuild" });
    expect(r.kind).toBe("unmeasured");
    expect(r.kind === "unmeasured" && r.detail).toMatch(/container.hosts names no host/);
    expect(r.kind === "unmeasured" && r.detail).toMatch(/UNMEASURED, not DOWN/);

    expect(containerProbeTarget({ hosts: [] }).kind).toBe("unmeasured");
    expect(containerProbeTarget({ hosts: ["localhost"] }).kind).toBe("unmeasured");
  });

  test("SC-2482: no port is invented, and 3000 least of all", () => {
    const r = containerProbeTarget({ hosts: ["localhost"] });
    expect(r.kind).toBe("unmeasured");
    expect(r.kind === "unmeasured" && r.detail).toMatch(/container.port is not a port number/);
    // The specific regression. `port || 3000` also swallowed 0, which is why
    // 0 is in the matrix as well as absent.
    expect(JSON.stringify(r)).not.toContain("3000");
    expect(containerProbeTarget({ hosts: ["localhost"], port: 0 }).kind).toBe("unmeasured");
    expect(containerProbeTarget({ hosts: ["localhost"], port: "7776" as never }).kind)
      .toBe("unmeasured");
  });

  test("SC-2483: a host that is not a hostname is refused, not sanitised", () => {
    // The host is interpolated unquoted into a curl line inside an agent
    // prompt, at both sites. Refusing is the only outcome that does not
    // require getting the quoting right somewhere downstream.
    for (const h of ["a;rm -rf /", "$(id)", "a b", "", "user@host", "host:1"]) {
      const r = containerProbeTarget({ hosts: [h], port: 7776 });
      expect(r.kind, `${h} was accepted as a host`).toBe("unmeasured");
    }
    // A usable host later in the list is still used: the array is a list of
    // candidates, and dropping all of them because the first is malformed
    // would turn a typo into an unmeasured run.
    const ok = containerProbeTarget({ hosts: ["bad host", "mini.local"], port: 7776 });
    expect(ok.kind).toBe("probe");
    expect(ok.kind === "probe" && ok.host).toBe("mini.local");
  });

  test("SC-2484: a well-formed container yields the URL, and the path is not guessed open", () => {
    const r = containerProbeTarget({ hosts: ["mini.local"], port: 7776, healthPath: "/health" });
    expect(r.kind).toBe("probe");
    expect(r.kind === "probe" && r.url).toBe("http://mini.local:7776/health");
    // An absent healthPath means the container root, which is the origin
    // itself and not a route that could 404 on a healthy server — the
    // distinction `probeTarget` refuses to guess for `dev.healthPath`.
    expect(containerProbeTarget({ hosts: ["mini.local"], port: 7776 }))
      .toMatchObject({ kind: "probe", url: "http://mini.local:7776/" });
    // A protocol-relative path is a different origin wearing a path's shape.
    expect(containerProbeTarget({ hosts: ["m"], port: 1, healthPath: "//evil.example.com/" }).kind)
      .toBe("unmeasured");
    expect(containerProbeTarget({ hosts: ["m"], port: 1, healthPath: "health" }).kind)
      .toBe("unmeasured");
  });

  test("SC-2485: safeUrl is what may be recorded, and url is what is probed", () => {
    const r = containerProbeTarget({
      hosts: ["mini.local"], port: 7776, healthPath: "/h?token=ghp_abcdefghij1234567890",
    });
    expect(r.kind).toBe("probe");
    expect(r.kind === "probe" && r.url).toContain("ghp_abcdefghij1234567890");
    expect(r.kind === "probe" && r.safeUrl).not.toContain("ghp_abcdefghij1234567890");
    expect(r.kind === "probe" && r.safeUrl).toContain("mini.local:7776");
  });

  test("SC-2486: no detail can break the command it is interpolated into", () => {
    // Every detail reaches `record-env` as a single-quoted JS literal inside
    // a double-quoted shell string. One apostrophe and the step fails for a
    // reason that has nothing to do with the container.
    for (const c of CASES) {
      const r = containerProbeTarget(c as never);
      if (r.kind === "probe") continue;
      expect(r.detail, `a quote in the detail for ${JSON.stringify(c)}`)
        .not.toMatch(/['"`$\\]/);
      expect(r.detail.length).toBeGreaterThan(10);
    }
  });
});

/**
 * The record-env step, run rather than read.
 *
 * The block is extracted from its markers and invoked with the module-scope
 * names ship.js gives it, so what is asserted below is the prompt the agent
 * is actually handed on each of the three branches.
 */
async function runRecordEnv(probe: Probe, prodQuinn: string): Promise<string> {
  const prompts: string[] = [];
  const factory = new Function(
    "containerProbe",
    "timedAgent",
    "HARNESS_ROOT",
    "WORK_DIR",
    "prodQuinn",
    `return (async () => {${sliceBlock("RECORD-ENV-ARMS")}})()`,
  );
  await factory(
    probe,
    async (p: string, o: { label: string }) => { prompts.push(`${o.label}\u0000${p}`); return {}; },
    "/harness",
    "/work",
    prodQuinn,
  );
  expect(prompts.length, "record-env ran on no arm, or on more than one").toBe(1);
  expect(prompts[0].startsWith("record-env\u0000")).toBe(true);
  return prompts[0].slice("record-env\u0000".length);
}

describe("#312 — record-env reports what the run measured", () => {
  const QUINN = "s.environments.prod.quinn = 'FAIL';";

  test("SC-2487: a container nothing could address records FAIL, with the reason", async () => {
    const probe = containerProbeTarget({ rebuildCommand: "make test-rebuild" }) as Probe;
    expect(probe.kind).toBe("unmeasured");
    const prompt = await runRecordEnv(probe, QUINN);

    expect(prompt).toContain("s.environments.prod.rebuild = 'FAIL'");
    expect(prompt).toContain("s.environments.prod.smoke = 'FAIL'");
    // Not SKIP. SKIP is counted in the gate's pass total, so recording one
    // here makes the run that measured least read as the cleanest — the
    // same argument #423 made for prod.quinn.
    expect(prompt).not.toContain("s.environments.prod.smoke = 'SKIP'");
    expect(prompt).not.toContain("test container not running");
    expect(prompt).toContain(probe.kind === "unmeasured" ? probe.detail : "");

    // And no probe is described at all: there is no URL to curl, so a step
    // that printed one would be inviting the agent to invent the host.
    expect(prompt).not.toContain("curl");
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain(":3000");
  });

  test("SC-2487: a reachable container is probed at the resolved URL", async () => {
    const probe = containerProbeTarget({
      hosts: ["mini.local"], port: 7776, healthPath: "/health",
    }) as Probe;
    expect(probe.kind).toBe("probe");
    const prompt = await runRecordEnv(probe, "s.environments.prod.quinn = 'PASS';");

    expect(prompt).toContain("http://mini.local:7776/health");
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain(":3000");
    // Both outcomes still offered: this arm is the one that genuinely can
    // report a down container, and it keeps saying so.
    expect(prompt).toContain("test container not running");
    expect(prompt).toContain("s.environments.prod.smoke = 'PASS'");
  });

  test("SC-2487: no container configured is still a SKIP, and says which", async () => {
    const probe = containerProbeTarget(null) as Probe;
    expect(probe.kind).toBe("unconfigured");
    const prompt = await runRecordEnv(probe, "s.environments.prod.quinn = 'SKIP';");

    expect(prompt).toContain("rebuild:'SKIP'");
    expect(prompt).toContain("smoke:'SKIP'");
    expect(prompt).toContain("no container");
    expect(prompt).not.toContain("curl");
  });

  test("SC-2487: every arm writes the Quinn verdict it was handed", async () => {
    // The third arm count, held at three so a fourth cannot be added with a
    // constant — #423's assertion, re-pinned now that there are three again
    // for a different reason.
    for (const probe of [
      containerProbeTarget({ rebuildCommand: "x" }),
      containerProbeTarget({ hosts: ["h"], port: 1 }),
      containerProbeTarget(null),
    ] as Probe[]) {
      const prompt = await runRecordEnv(probe, "s.environments.prod.quinn = 'SENTINEL';");
      expect(prompt, `arm ${probe.kind} dropped the measurement`).toContain("'SENTINEL'");
    }
  });
});
