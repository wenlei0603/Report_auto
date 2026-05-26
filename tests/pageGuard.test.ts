import { describe, expect, it } from "vitest";
import { PageGuard } from "../src/domain/pageGuard.js";

describe("page guard", () => {
  it("tracks remaining pages and rejects limit crossings", () => {
    const guard = new PageGuard(10, 3);
    expect(guard.remaining).toBe(7);
    expect(guard.canSpend(7)).toBe(true);
    expect(guard.canSpend(8)).toBe(false);
    guard.spend(7);
    expect(guard.used).toBe(10);
    expect(() => guard.spend(1)).toThrow(/Page limit exceeded/);
    guard.refund(4);
    expect(guard.used).toBe(6);
    expect(guard.remaining).toBe(4);
  });
});
