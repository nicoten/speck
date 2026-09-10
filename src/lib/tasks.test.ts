import { describe, expect, it } from "vitest";
import { pendingKey, withPending } from "./tasks";
import type { TaskDoc } from "./markdown/parse";

const doc = (...groups: [string | null, ...[string, boolean][]][]): TaskDoc => {
  const gs = groups.map(([title, ...items]) => ({
    title,
    items: items.map(([text, done]) => ({ text, done })),
  }));
  const all = gs.flatMap((g) => g.items);
  return {
    groups: gs,
    done: all.filter((i) => i.done).length,
    total: all.length,
    notes: "",
  };
};

describe("withPending", () => {
  it("numbers repeated wording by occurrence, counting across groups", () => {
    const out = withPending(
      doc(["One", ["Write a test", false], ["Ship it", false]], ["Two", ["Write a test", false]]),
      new Map(),
    );
    expect(out.groups[0].items.map((i) => [i.text, i.occurrence])).toEqual([
      ["Write a test", 0],
      ["Ship it", 0],
    ]);
    // The same wording in a later group is the second occurrence, not a reset.
    expect(out.groups[1].items[0].occurrence).toBe(1);
  });

  it("leaves the document alone when nothing is pending", () => {
    const before = doc([null, ["a", true], ["b", false]]);
    const out = withPending(before, new Map());
    expect(out.groups[0].items.map((i) => i.done)).toEqual([true, false]);
    expect(out.done).toBe(1);
    expect(out.total).toBe(2);
  });

  it("shows a pending tick before the file says so", () => {
    const out = withPending(
      doc([null, ["a", false], ["b", false]]),
      new Map([[pendingKey("a", 0), true]]),
    );
    expect(out.groups[0].items.map((i) => i.done)).toEqual([true, false]);
  });

  it("shows a pending untick too", () => {
    const out = withPending(
      doc([null, ["a", true]]),
      new Map([[pendingKey("a", 0), false]]),
    );
    expect(out.groups[0].items[0].done).toBe(false);
  });

  it("recounts the summary so the meter moves with the box", () => {
    const out = withPending(
      doc([null, ["a", false], ["b", false], ["c", true]]),
      new Map([[pendingKey("a", 0), true]]),
    );
    expect(out.done).toBe(2);
    expect(out.total).toBe(3);
  });

  it("applies a pending change to the occurrence named and no other", () => {
    const out = withPending(
      doc([null, ["same", false], ["same", false], ["same", false]]),
      new Map([[pendingKey("same", 1), true]]),
    );
    expect(out.groups[0].items.map((i) => i.done)).toEqual([false, true, false]);
  });

  it("ignores a pending entry whose task is no longer in the file", () => {
    // The agent rewrote tasks.md between the click and the reload; the entry
    // has nothing to apply to and must not invent a row.
    const out = withPending(
      doc([null, ["still here", false]]),
      new Map([[pendingKey("deleted task", 0), true]]),
    );
    expect(out.groups[0].items.map((i) => [i.text, i.done])).toEqual([
      ["still here", false],
    ]);
    expect(out.total).toBe(1);
  });

  it("keeps the notes and group titles", () => {
    const before = doc(["Storage", ["a", false]]);
    const out = withPending({ ...before, notes: "prose" }, new Map());
    expect(out.groups[0].title).toBe("Storage");
    expect(out.notes).toBe("prose");
  });
});

describe("pendingKey", () => {
  it("separates text from occurrence so wording cannot collide", () => {
    // "a" at occurrence 11 and "a1" at occurrence 1 must not share a key.
    expect(pendingKey("a", 11)).not.toBe(pendingKey("a1", 1));
  });
});
