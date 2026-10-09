import { describe, expect, it } from "vitest";
import { expectedChunkSize } from "./uploads.js";

describe("expectedChunkSize", () => {
  it("expects full chunks and a shorter last one", () => {
    expect(expectedChunkSize(25, 10, 0)).toBe(10);
    expect(expectedChunkSize(25, 10, 1)).toBe(10);
    expect(expectedChunkSize(25, 10, 2)).toBe(5);
  });

  it("expects a full last chunk when the size divides evenly", () => {
    expect(expectedChunkSize(20, 10, 1)).toBe(10);
  });

  it("rejects indexes outside the file", () => {
    expect(expectedChunkSize(20, 10, 2)).toBe(-1);
    expect(expectedChunkSize(20, 10, -1)).toBe(-1);
  });
});
