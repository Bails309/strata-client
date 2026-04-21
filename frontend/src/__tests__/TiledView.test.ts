import { describe, it, expect } from "vitest";
import { computeGrid } from "../pages/TiledView";

describe("computeGrid", () => {
  it("returns 1×1 for zero or negative input", () => {
    expect(computeGrid(0)).toEqual({ cols: 1, rows: 1 });
    expect(computeGrid(-1)).toEqual({ cols: 1, rows: 1 });
    expect(computeGrid(-100)).toEqual({ cols: 1, rows: 1 });
  });

  it("returns 1×1 for a single tile", () => {
    expect(computeGrid(1)).toEqual({ cols: 1, rows: 1 });
  });

  it("returns 2×1 for two tiles", () => {
    expect(computeGrid(2)).toEqual({ cols: 2, rows: 1 });
  });

  it("returns 2×2 for three tiles", () => {
    expect(computeGrid(3)).toEqual({ cols: 2, rows: 2 });
  });

  it("returns 2×2 for four tiles", () => {
    expect(computeGrid(4)).toEqual({ cols: 2, rows: 2 });
  });

  it("returns 3×2 for six tiles", () => {
    expect(computeGrid(6)).toEqual({ cols: 3, rows: 2 });
  });

  it("returns 3×3 for nine tiles", () => {
    expect(computeGrid(9)).toEqual({ cols: 3, rows: 3 });
  });

  it("returns 4×3 for twelve tiles", () => {
    expect(computeGrid(12)).toEqual({ cols: 4, rows: 3 });
  });

  it("handles large counts", () => {
    const result = computeGrid(100);
    expect(result.cols).toBe(10);
    expect(result.rows).toBe(10);
    expect(result.cols * result.rows).toBeGreaterThanOrEqual(100);
  });
});
