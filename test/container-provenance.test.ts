/**
 * `container-has-fix` passed on four distinct unmeasurable states (#341).
 *
 * The check asks whether the promoted container is built from the commit
 * under test. Every way of failing to find that out returned a pass:
 * container absent, daemon down, image carrying no revision label, neither
 * runtime installed. Four separate facts, one observable outcome.
 *
 * Two of them are *more likely* exactly when the check matters. An image
 * that was never rebuilt may not exist under the expected name; a stopped
 * runtime is the normal state on a machine where promotion did not happen.
 * The check was quietest in precisely the situation it exists to catch.
 *
 * The runtime was chosen by probe, not config: `podman` if present,
 * otherwise `docker` whether docker existed or not. A consumer with no
 * container runtime at all got a green `container-has-fix` on every run, for
 * ever.
 *
 * ## What is NOT decided here, and why that is not a dodge
 *
 * Whether an unreadable inspect should FAIL is #341 criterion 1's question, and criterion 1
 * asks for frequencies measured on a real consumer before the decision. Only
 * a measured `BEHIND` blocks today — which is what blocked before — and every
 * unmeasurable outcome carries `blocking: false`. The test below pins that,
 * so flipping one is a deliberate edit with a red test behind it rather than
 * a drift.
 *
 * Recording without deciding is normally the failure #346 was about. The
 * difference is that here the recording IS the deliverable: criterion 1 cannot be
 * answered without it.
 *
 * Covers SC-783..786 of GATE-CONTRACTS-SPEC.md.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import {
  classifyContainerProvenance,
  classifyInspectFailure,
  containerProvenanceViolations,
  KNOWN_RUNTIMES,
  resolveContainerRuntime,
  type ProvenanceOutcome,
  type ProvenanceReading,
} from "../lib/container-provenance";

const REPO = join(import.meta.dir, "..");
const HEAD = "a".repeat(40);

function reading(over: Partial<ProvenanceReading> = {}): ProvenanceReading {
  return {
    runtime: { kind: "resolved", runtime: "podman", source: "probe" },
    containerName: "app-prod",
    inspect: { ok: true, output: HEAD, stderr: "" },
    head: { ok: true, output: HEAD },
    prodRebuild: undefined,
    ...over,
  };
}

describe("#341: the four silent returns are four named outcomes", () => {
  test("no runtime available is NO_RUNTIME, not a pass", () => {
    const r = classifyContainerProvenance(
      reading({ runtime: resolveContainerRuntime(undefined, () => false), inspect: undefined }),
    );
    expect(r.outcome).toBe("NO_RUNTIME");
    expect(r.measured).toBe(false);
  });

  test("an absent container is CONTAINER_ABSENT, which is the state the check exists for", () => {
    const r = classifyContainerProvenance(
      reading({ inspect: { ok: false, output: "", stderr: 'Error: no such object: app-prod' } }),
    );
    expect(r.outcome).toBe("CONTAINER_ABSENT");
    expect(r.measured).toBe(false);
    expect(r.detail).toContain("never rebuilt");
  });

  test("a dead daemon is RUNTIME_DOWN, which says nothing about the container", () => {
    const r = classifyContainerProvenance(
      reading({ inspect: { ok: false, output: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" } }),
    );
    expect(r.outcome).toBe("RUNTIME_DOWN");
    expect(r.detail).toContain("says nothing about the container");
  });

  test("an unrecognised inspect failure keeps its stderr instead of being filed", () => {
    // A narrow detector that guesses is worse than one that says it does not
    // know. The stderr is carried so the next reader can widen the matcher
    // on evidence rather than on imagination.
    const r = classifyContainerProvenance(
      reading({ inspect: { ok: false, output: "", stderr: "permission denied while trying to connect" } }),
    );
    expect(r.outcome).toBe("INSPECT_FAILED");
    expect(r.detail).toContain("permission denied");
  });

  test("an image with no revision label is NO_REVISION_LABEL", () => {
    const r = classifyContainerProvenance(reading({ inspect: { ok: true, output: "", stderr: "" } }));
    expect(r.outcome).toBe("NO_REVISION_LABEL");
    expect(r.detail).toContain("provenance");
  });

  test("an unreadable HEAD is HEAD_UNREADABLE", () => {
    const r = classifyContainerProvenance(reading({ head: { ok: false, output: "" } }));
    expect(r.outcome).toBe("HEAD_UNREADABLE");
  });

  test("the outcomes are distinct — no two of these share one", () => {
    // criterion 2 restated as an assertion. The defect was four facts collapsing
    // into one observable result, so "they are different" is the claim and
    // it should be checked rather than read off the source.
    const seen = new Set<ProvenanceOutcome>([
      classifyContainerProvenance(reading({ runtime: resolveContainerRuntime(undefined, () => false), inspect: undefined })).outcome,
      classifyContainerProvenance(reading({ inspect: { ok: false, output: "", stderr: "no such object" } })).outcome,
      classifyContainerProvenance(reading({ inspect: { ok: false, output: "", stderr: "cannot connect" } })).outcome,
      classifyContainerProvenance(reading({ inspect: { ok: true, output: "", stderr: "" } })).outcome,
      classifyContainerProvenance(reading({ head: { ok: false, output: "" } })).outcome,
    ]);
    expect(seen.size).toBe(5);
  });
});

describe("#341: a measured reading still decides", () => {
  test("a matching revision is MATCH and measured", () => {
    const r = classifyContainerProvenance(reading());
    expect(r.outcome).toBe("MATCH");
    expect(r.measured).toBe(true);
    expect(containerProvenanceViolations(r)).toEqual([]);
  });

  test("a behind revision with no rebuild blocks — the behaviour that already existed", () => {
    const r = classifyContainerProvenance(
      reading({ inspect: { ok: true, output: "b".repeat(40), stderr: "" } }),
    );
    expect(r.outcome).toBe("BEHIND");
    expect(r.blocking).toBe(true);
    expect(containerProvenanceViolations(r).length).toBe(1);
  });

  test("a behind revision WITH prod.rebuild PASS does not block", () => {
    const r = classifyContainerProvenance(
      reading({ inspect: { ok: true, output: "b".repeat(40), stderr: "" }, prodRebuild: "PASS" }),
    );
    expect(r.outcome).toBe("BEHIND");
    expect(r.blocking).toBe(false);
    expect(containerProvenanceViolations(r)).toEqual([]);
  });

  test("no unmeasurable outcome blocks, pending criterion 1", () => {
    // Pinned on purpose. #341 criterion 1 asks for the frequency of each state on a
    // real consumer BEFORE deciding which should refuse, because turning
    // runs red on a machine whose runtime happens to be down is a behaviour
    // change. When criterion 1 is answered this test is the thing that must change,
    // which is the point — the decision becomes a deliberate edit.
    const unmeasurable: ProvenanceReading[] = [
      reading({ runtime: resolveContainerRuntime(undefined, () => false), inspect: undefined }),
      reading({ inspect: { ok: false, output: "", stderr: "no such object" } }),
      reading({ inspect: { ok: false, output: "", stderr: "cannot connect" } }),
      reading({ inspect: { ok: false, output: "", stderr: "something new" } }),
      reading({ inspect: { ok: true, output: "", stderr: "" } }),
      reading({ head: { ok: false, output: "" } }),
    ];
    for (const r of unmeasurable) {
      const v = classifyContainerProvenance(r);
      expect(v.blocking, v.outcome).toBe(false);
      expect(v.measured, v.outcome).toBe(false);
    }
  });
});

describe("#341: the runtime comes from config, with the probe as a fallback", () => {
  test("a configured runtime that exists is used, and says it came from config", () => {
    const r = resolveContainerRuntime("nerdctl", n => n === "nerdctl");
    expect(r).toEqual({ kind: "resolved", runtime: "nerdctl", source: "config" });
  });

  test("a configured runtime that does not exist is NONE, not a silent docker attempt", () => {
    // The old line fell through to docker whatever the project said. A
    // project that configures nerdctl and does not have it should hear that,
    // not get a docker error it never asked for.
    const r = resolveContainerRuntime("nerdctl", () => false);
    expect(r.kind).toBe("none");
    expect(r.kind === "none" && r.detail).toContain("nerdctl");
  });

  test("with no config the probe order is tried and the source says probe", () => {
    expect(resolveContainerRuntime(undefined, n => n === "docker")).toEqual({
      kind: "resolved", runtime: "docker", source: "probe",
    });
    expect(resolveContainerRuntime("", n => n === "podman")).toEqual({
      kind: "resolved", runtime: "podman", source: "probe",
    });
  });

  test("neither runtime installed is NONE and names what it looked for", () => {
    const r = resolveContainerRuntime(undefined, () => false);
    expect(r.kind).toBe("none");
    for (const name of KNOWN_RUNTIMES) {
      expect(r.kind === "none" && r.detail, name).toContain(name);
    }
  });

  test("the probe is never consulted when config answers", () => {
    // Otherwise "config first" is a comment rather than a behaviour.
    let probed = 0;
    resolveContainerRuntime("podman", () => { probed++; return true; });
    expect(probed).toBe(1); // availability of the configured one only
  });
});

describe("#341: the gate consumes it, and the config keys are declared", () => {
  test("the check routes through the classifier and its violations function", () => {
    const src = readFileSync(join(REPO, "gates", "workflow.test.ts"), "utf-8");
    expect(src).toContain("classifyContainerProvenance({");
    expect(src).toContain("containerProvenanceViolations(verdict)");
    // The probe-only runtime choice is gone.
    expect(src).not.toContain('exec("command -v podman") .ok ? "podman" : "docker"');
    // Every outcome reaches the log, so criterion 1's frequencies are collectable
    // from real runs rather than needing instrumentation added later.
    expect(src).toContain("container-has-fix: ${verdict.outcome}");
  });

  test("none of the early returns that shared a PASS survive", () => {
    const src = readFileSync(join(REPO, "gates", "workflow.test.ts"), "utf-8");
    const check = src.slice(
      src.indexOf("container-has-fix: container image SHA matches HEAD"),
      src.indexOf("all-acs-have-evidence"),
    );
    expect(check.length).toBeGreaterThan(0);
    expect(check).not.toContain("if (!inspect.ok || !inspect.output) return;");
    expect(check).not.toContain("if (!head.ok) return;");
  });

  test("containerName, imageName and containerRuntime are declared in the schema", () => {
    // They were read by the gate and declared by nothing. ProdSchema is not
    // passthrough, so any caller going through zod dropped them silently.
    const schema = readFileSync(join(REPO, "lib", "rungate-schema.ts"), "utf-8");
    const prod = schema.slice(schema.indexOf("export const ProdSchema"), schema.indexOf("const McpServerSchema"));
    for (const key of ["containerName", "imageName", "containerRuntime"]) {
      expect(prod, key).toContain(`${key}:`);
    }
  });
});

describe("#341 criterion 5: the absent-container case is DRIVEN, not described", () => {
  /**
   * Every case above hands the classifier a hand-written reading, which
   * proves it can read a string. Criterion 5 asks for the real path: point the real
   * inspect at a container that does not exist and see what comes back.
   *
   * This is the case the old code was quietest about — an image that was
   * never rebuilt does not exist under the expected name — so it is the one
   * worth driving rather than describing.
   */
  const available = (name: string) =>
    spawnSync("command", ["-v", name], { shell: true, encoding: "utf-8" }).status === 0;

  test("a real inspect of a nonexistent container classifies as CONTAINER_ABSENT", () => {
    const runtime = resolveContainerRuntime(undefined, available);
    if (runtime.kind === "none") {
      // No runtime here. That is itself one of the outcomes, and asserting
      // it keeps this from being a test that quietly does nothing on a
      // machine without podman or docker — which is exactly the shape #341
      // is about.
      expect(
        classifyContainerProvenance(reading({ runtime, inspect: undefined })).outcome,
      ).toBe("NO_RUNTIME");
      return;
    }

    const name = "rungate-no-such-container-9f3a2c";
    const r = spawnSync(
      runtime.runtime,
      ["inspect", '--format={{index .Config.Labels "org.opencontainers.image.revision"}}', "--", name],
      { encoding: "utf-8", timeout: 30000 },
    );
    const stderr = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const verdict = classifyContainerProvenance(
      reading({
        runtime,
        containerName: name,
        inspect: { ok: r.status === 0, output: r.status === 0 ? (r.stdout ?? "").trim() : "", stderr },
      }),
    );

    // Whatever the runtime said, the one thing that must NOT happen is the
    // old behaviour: a silent pass indistinguishable from a matching image.
    expect(verdict.measured, `${verdict.outcome}: ${verdict.detail}`).toBe(false);
    expect(["CONTAINER_ABSENT", "RUNTIME_DOWN", "INSPECT_FAILED"]).toContain(verdict.outcome);
    // On a machine whose runtime is actually answering it is the absent case.
    if (verdict.outcome !== "RUNTIME_DOWN" && verdict.outcome !== "INSPECT_FAILED") {
      expect(verdict.outcome).toBe("CONTAINER_ABSENT");
    }
  }, 60_000);

  test("the same path with a matching revision is MATCH — the control", () => {
    // The positive half, so a classifier that returned an unmeasurable
    // outcome for everything could not satisfy the case above.
    const runtime = resolveContainerRuntime(undefined, available);
    const v = classifyContainerProvenance(
      reading({ runtime: runtime.kind === "none" ? { kind: "resolved", runtime: "podman", source: "probe" } : runtime }),
    );
    expect(v.outcome).toBe("MATCH");
    expect(v.measured).toBe(true);
  });
});

describe("#341: classifyInspectFailure is a matcher, not a guess", () => {
  test("the phrases each runtime actually prints are recognised", () => {
    expect(classifyInspectFailure("Error: no such object: app")).toBe("CONTAINER_ABSENT");
    expect(classifyInspectFailure("Error: No such container: app")).toBe("CONTAINER_ABSENT");
    expect(classifyInspectFailure("Cannot connect to the Docker daemon")).toBe("RUNTIME_DOWN");
    expect(classifyInspectFailure("dial unix /run/podman.sock: connect: connection refused")).toBe("RUNTIME_DOWN");
  });

  test("anything else stays unclassified rather than being forced into a bucket", () => {
    expect(classifyInspectFailure("")).toBe("INSPECT_FAILED");
    expect(classifyInspectFailure("permission denied")).toBe("INSPECT_FAILED");
  });
});
