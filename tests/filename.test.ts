import { describe, expect, it } from "vitest";
import { sanitizeFilename } from "../src/utils/filename.js";

describe("filename sanitizer", () => {
  it("removes Windows-invalid characters and trims trailing dots", () => {
    expect(sanitizeFilename('A/B:C*D?"E<>|.')).toBe("A_B_C_D_E_");
  });

  it("uses a fallback for empty names", () => {
    expect(sanitizeFilename("   ... ")).toBe("report");
  });
});
