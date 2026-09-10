/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PANE, locate, matchOffsets } from "./find";

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("matchOffsets", () => {
  it("finds nothing for an empty query", () => {
    expect(matchOffsets("proposal", "")).toEqual([]);
  });

  it("finds every occurrence, in document order", () => {
    expect(matchOffsets("spec, spec, spec", "spec")).toEqual([0, 6, 12]);
  });

  it("ignores case on both sides", () => {
    expect(matchOffsets("ADDED and added", "Added")).toEqual([0, 10]);
  });

  it("counts matches without overlapping them", () => {
    // A find bar's "2 of 2" has to mean two distinct highlights, and
    // overlapping ranges cannot both be shown.
    expect(matchOffsets("aaaa", "aa")).toEqual([0, 2]);
  });

  it("finds a query that is longer than the text, or absent, as nothing", () => {
    expect(matchOffsets("spec", "specification")).toEqual([]);
    expect(matchOffsets("proposal", "tasks")).toEqual([]);
  });

  it("keeps offsets aligned when a character case-folds to two", () => {
    // "İ".toLowerCase() is two code units. Folding it would slide every offset
    // after it, and the highlight would land a character off for the rest of
    // the document.
    expect(matchOffsets("İ spec", "spec")).toEqual([2]);
  });
});

describe("locate", () => {
  const starts = [0, 5, 5, 9]; // the third node is empty

  it("has nowhere to point when there is no text", () => {
    expect(locate([], 0)).toEqual({ index: -1, offset: 0 });
  });

  it("points into the node an offset falls in", () => {
    expect(locate(starts, 0)).toEqual({ index: 0, offset: 0 });
    expect(locate(starts, 3)).toEqual({ index: 0, offset: 3 });
    expect(locate(starts, 10)).toEqual({ index: 3, offset: 1 });
  });

  it("puts a boundary offset at the start of the later node", () => {
    // A match beginning exactly where a node begins belongs to that node, not
    // to the end of the one before it.
    expect(locate(starts, 5)).toEqual({ index: 2, offset: 0 });
    expect(locate(starts, 9)).toEqual({ index: 3, offset: 0 });
  });
});

describe("the pane find searches", () => {
  it("is the root class all three main-pane views actually render", () => {
    // Find resolves its search root by class rather than by ref, because the
    // reader and both dashboards are separate components that each render it.
    // Renaming the class in one of them would silently narrow the search.
    expect(PANE).toBe(".reader");
    for (const view of ["Reader", "ProjectDashboard", "ChangeDashboard"]) {
      expect(
        source(`../components/${view}.tsx`),
        `${view} no longer renders ${PANE}`,
      ).toContain('className="reader"');
    }
  });
});
