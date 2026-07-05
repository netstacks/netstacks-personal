import { describe, it, expect } from "vitest";
import {
  toggleSelection,
  isInsideBox,
  selectInBox,
  applyGroupDelta,
} from "../topologySelection";

describe("toggleSelection", () => {
  it("adds id when additive=true and not present", () => {
    const current = new Set(["a", "b"]);
    const result = toggleSelection(current, "c", true);
    expect(result).toEqual(new Set(["a", "b", "c"]));
    expect(current).toEqual(new Set(["a", "b"])); // immutable
  });

  it("removes id when additive=true and present", () => {
    const current = new Set(["a", "b", "c"]);
    const result = toggleSelection(current, "b", true);
    expect(result).toEqual(new Set(["a", "c"]));
    expect(current).toEqual(new Set(["a", "b", "c"])); // immutable
  });

  it("replaces with single id when additive=false", () => {
    const current = new Set(["a", "b", "c"]);
    const result = toggleSelection(current, "d", false);
    expect(result).toEqual(new Set(["d"]));
    expect(current).toEqual(new Set(["a", "b", "c"])); // immutable
  });

  it("returns new Set even when replacing with same id", () => {
    const current = new Set(["a"]);
    const result = toggleSelection(current, "a", false);
    expect(result).toEqual(new Set(["a"]));
    expect(result).not.toBe(current);
  });
});

describe("isInsideBox", () => {
  it("returns true for point inside box (normal drag left→right, top→down)", () => {
    const box = { x1: 10, y1: 20, x2: 50, y2: 60 };
    expect(isInsideBox({ x: 30, y: 40 }, box)).toBe(true);
  });

  it("returns true for point inside box (reverse drag right→left, bottom→up)", () => {
    const box = { x1: 50, y1: 60, x2: 10, y2: 20 };
    expect(isInsideBox({ x: 30, y: 40 }, box)).toBe(true);
  });

  it("returns true for point on boundary (inclusive)", () => {
    const box = { x1: 10, y1: 20, x2: 50, y2: 60 };
    expect(isInsideBox({ x: 10, y: 20 }, box)).toBe(true);
    expect(isInsideBox({ x: 50, y: 60 }, box)).toBe(true);
    expect(isInsideBox({ x: 30, y: 20 }, box)).toBe(true);
  });

  it("returns false for point outside box", () => {
    const box = { x1: 10, y1: 20, x2: 50, y2: 60 };
    expect(isInsideBox({ x: 5, y: 40 }, box)).toBe(false);
    expect(isInsideBox({ x: 30, y: 70 }, box)).toBe(false);
    expect(isInsideBox({ x: 60, y: 40 }, box)).toBe(false);
  });
});

describe("selectInBox", () => {
  const devices = [
    { id: "d1", x: 10, y: 10 },
    { id: "d2", x: 30, y: 30 },
    { id: "d3", x: 50, y: 50 },
    { id: "d4", x: 70, y: 70 },
  ];

  it("returns devices inside box when additive=false (replace)", () => {
    const box = { x1: 20, y1: 20, x2: 60, y2: 60 };
    const base = new Set(["d1", "d4"]);
    const result = selectInBox(devices, box, base, false);
    expect(result).toEqual(new Set(["d2", "d3"]));
  });

  it("returns union with base when additive=true", () => {
    const box = { x1: 20, y1: 20, x2: 60, y2: 60 };
    const base = new Set(["d1", "d4"]);
    const result = selectInBox(devices, box, base, true);
    expect(result).toEqual(new Set(["d1", "d2", "d3", "d4"]));
  });

  it("returns empty set when no devices inside box (additive=false)", () => {
    const box = { x1: 100, y1: 100, x2: 200, y2: 200 };
    const base = new Set(["d1"]);
    const result = selectInBox(devices, box, base, false);
    expect(result).toEqual(new Set());
  });

  it("works with reversed box coordinates", () => {
    const box = { x1: 60, y1: 60, x2: 20, y2: 20 };
    const base = new Set<string>();
    const result = selectInBox(devices, box, base, false);
    expect(result).toEqual(new Set(["d2", "d3"]));
  });
});

describe("applyGroupDelta", () => {
  it("applies delta to all positions", () => {
    const starts = new Map([
      ["a", { x: 100, y: 200 }],
      ["b", { x: 300, y: 400 }],
    ]);
    const result = applyGroupDelta(starts, 50, -30);
    expect(result).toEqual(
      new Map([
        ["a", { x: 150, y: 170 }],
        ["b", { x: 350, y: 370 }],
      ])
    );
  });

  it("clamps at clampMin (0)", () => {
    const starts = new Map([
      ["a", { x: 10, y: 20 }],
      ["b", { x: 5, y: 15 }],
    ]);
    const result = applyGroupDelta(starts, -50, -30);
    expect(result).toEqual(
      new Map([
        ["a", { x: 0, y: 0 }],
        ["b", { x: 0, y: 0 }],
      ])
    );
  });

  it("clamps at clampMax (1000)", () => {
    const starts = new Map([
      ["a", { x: 980, y: 990 }],
      ["b", { x: 950, y: 960 }],
    ]);
    const result = applyGroupDelta(starts, 50, 30);
    expect(result).toEqual(
      new Map([
        ["a", { x: 1000, y: 1000 }],
        ["b", { x: 1000, y: 990 }],
      ])
    );
  });

  it("returns new Map (immutable)", () => {
    const starts = new Map([["a", { x: 100, y: 200 }]]);
    const result = applyGroupDelta(starts, 10, 20);
    expect(result).not.toBe(starts);
    expect(starts.get("a")).toEqual({ x: 100, y: 200 }); // unchanged
  });

  it("handles custom clamp bounds", () => {
    const starts = new Map([["a", { x: 50, y: 150 }]]);
    const result = applyGroupDelta(starts, -60, 60, 10, 200);
    expect(result).toEqual(new Map([["a", { x: 10, y: 200 }]]));
  });
});
