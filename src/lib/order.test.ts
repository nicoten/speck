import { describe, expect, it } from "vitest";
import {
  findByPath,
  firstDoc,
  flatten,
  neighbours,
  readingSequence,
} from "./order";
import type { ArtifactGroup, Doc, ProjectTree } from "./types";

let seq = 0;

const doc = (title: string, kind: Doc["kind"] = "other"): Doc => ({
  id: title,
  title,
  path: `/p/${title}`,
  kind,
  seq: ++seq,
});

const group = (
  id: string,
  label: string,
  step: number,
  docs: Doc[],
): ArtifactGroup => ({
  id,
  label,
  step,
  status: docs.length ? "done" : "pending",
  docs,
  missing: docs.length === 0,
  // Only the specs artifact is identified by capability path.
  nested: id === "specs",
  completedTasks: id === "tasks" ? 1 : null,
  totalTasks: id === "tasks" ? 2 : null,
  // Unwritten is pending; the furthest written step is current; earlier ones
  // are settled.
  state: docs.length === 0 ? "pending" : id === "tasks" ? "current" : "complete",
});

/**
 * A tree shaped like the backend produces: context, a change grouped by
 * artifact (with `Design` unwritten), nested specs, and an archive.
 */
function tree(): ProjectTree {
  seq = 0;
  const config = doc("config.yaml", "context");
  const proposal = doc("proposal.md", "proposal");
  const deltaA = doc("identity/user-auth", "specDelta");
  const deltaB = doc("billing", "specDelta");
  const tasks = doc("tasks.md", "tasks");
  const spec = doc("billing-spec", "spec");
  const archived = doc("old-proposal.md", "proposal");

  return {
    root: "/p",
    name: "demo",
    schema: { name: "spec-driven", description: null, artifacts: [], assumed: false },
    source: "cli",
    warnings: [],
    docCount: 7,
    sections: [
      { kind: "project", items: [config] },
      {
        kind: "activeChanges",
        items: [
          {
            name: "add-user-auth",
            status: "in-progress",
            completedTasks: 1,
            totalTasks: 2,
            lastModified: null,
            archivedOn: null,
            artifacts: [
              group("proposal", "Proposal", 1, [proposal]),
              group("specs", "Specs", 2, [deltaA, deltaB]),
              group("design", "Design", 3, []),
              group("tasks", "Tasks", 4, [tasks]),
            ],
          },
        ],
      },
      {
        kind: "specs",
        items: [
          {
            id: "identity",
            label: "identity",
            requirementCount: null,
            doc: null,
            children: [
              {
                id: "identity/billing",
                label: "billing",
                requirementCount: 1,
                doc: spec,
                children: [],
              },
            ],
          },
        ],
      },
      {
        kind: "archive",
        items: [
          {
            name: "old-thing",
            status: "complete",
            completedTasks: 1,
            totalTasks: 1,
            lastModified: null,
            archivedOn: "2026-01-01",
            artifacts: [group("proposal", "Proposal", 1, [archived])],
          },
        ],
      },
    ],
  };
}

describe("flatten", () => {
  it("walks sections, then changes, then artifacts in schema order", () => {
    expect(flatten(tree()).map((r) => r.doc.title)).toEqual([
      "config.yaml",
      "proposal.md",
      "identity/user-auth",
      "billing",
      "tasks.md",
      "billing-spec",
      "old-proposal.md",
    ]);
  });

  it("records the owning change and artifact for each document", () => {
    const refs = flatten(tree());
    expect(refs[1].changeName).toBe("add-user-auth");
    expect(refs[1].artifactId).toBe("proposal");
    expect(refs[1].artifactLabel).toBe("Proposal");
    expect(refs[2].artifactId).toBe("specs");
    expect(refs[3].artifactId).toBe("specs");
    expect(refs[4].artifactId).toBe("tasks");
  });

  it("carries the change itself, so the reader can show its progress", () => {
    const refs = flatten(tree());
    expect(refs[1].change?.name).toBe("add-user-auth");
    expect(refs[1].change?.artifacts.map((a) => a.label)).toEqual([
      "Proposal",
      "Specs",
      "Design",
      "Tasks",
    ]);
    // Documents outside a change have no change to report.
    expect(refs[0].change).toBeUndefined();
    expect(refs[5].change).toBeUndefined();
  });

  it("yields nothing for an unwritten artifact", () => {
    const refs = flatten(tree());
    expect(refs.some((r) => r.artifactLabel === "Design")).toBe(false);
  });

  it("skips intermediate spec segments that have no document", () => {
    expect(flatten(tree()).some((r) => r.doc.title === "identity")).toBe(false);
  });
});

describe("readingSequence", () => {
  it("is contiguous and matches the order the backend numbered", () => {
    const refs = readingSequence(tree());
    expect(refs.map((r) => r.doc.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("neighbours", () => {
  it("steps through the delta specs inside one artifact", () => {
    const t = tree();
    const { prev, next } = neighbours(t, "/p/identity/user-auth");
    expect(prev?.doc.title).toBe("proposal.md");
    expect(next?.doc.title).toBe("billing");
  });

  it("crosses from one artifact to the next", () => {
    const { next } = neighbours(tree(), "/p/billing");
    expect(next?.doc.title).toBe("tasks.md");
    expect(next?.artifactLabel).toBe("Tasks");
  });

  it("has no prev at the start and no next at the end", () => {
    const t = tree();
    expect(neighbours(t, "/p/config.yaml").prev).toBeNull();
    expect(neighbours(t, "/p/old-proposal.md").next).toBeNull();
  });

  it("reports index -1 when nothing is open", () => {
    expect(neighbours(tree(), null).index).toBe(-1);
  });
});

describe("firstDoc and findByPath", () => {
  it("opens at the first document of the sequence", () => {
    expect(firstDoc(tree())?.doc.title).toBe("config.yaml");
  });

  it("finds a document by path", () => {
    expect(findByPath(tree(), "/p/tasks.md")?.doc.kind).toBe("tasks");
    expect(findByPath(tree(), "/p/nope")).toBeUndefined();
  });
});
