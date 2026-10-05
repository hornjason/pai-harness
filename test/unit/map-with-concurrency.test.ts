import { describe, it, expect } from "bun:test";
import { mapWithConcurrency, REPORAILS_CONCURRENCY } from "../../lib/compliance";

/**
 * The compliance surface is scanned by spawning one `npx @reporails/cli` per
 * file. Run serially that was ~257s against a 240s test budget. These guard
 * the concurrency helper that fixed it — order preservation, the in-flight
 * cap, and the fact that work actually overlaps.
 */
describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const delays = [40, 5, 30, 1, 20];
    const out = await mapWithConcurrency(delays, 4, async d => {
      await Bun.sleep(d);
      return d;
    });
    expect(out).toEqual(delays);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      inFlight--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("actually overlaps work rather than running serially", async () => {
    const start = Date.now();
    await mapWithConcurrency(Array.from({ length: 8 }, (_, i) => i), 8, async () => {
      await Bun.sleep(50);
      return null;
    });
    // Serial would be ~400ms; 8-way should land near one 50ms slice.
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("handles an empty input without hanging", async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([]);
  });

  it("spawns no more workers than there are items", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2], 16, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      inFlight--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("scans the compliance surface with real parallelism", () => {
    expect(REPORAILS_CONCURRENCY).toBeGreaterThan(1);
  });
});
