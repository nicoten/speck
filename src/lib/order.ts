// Flattening the lifecycle tree into the reading sequence.
//
// The backend numbers documents; this walks the tree in display order to build
// the array prev/next navigates, along with the owning change and artifact each
// document belongs to. Walk order here must match the backend's numbering, and
// the tests assert exactly that.

import type { ChangeNode, Doc, ProjectTree, Section, SpecNode } from "./types";

export interface DocRef {
  doc: Doc;
  section: Section["kind"];
  /** Owning change, for documents inside a change. */
  changeName?: string;
  /** The change itself, so the reader can show its progress. */
  change?: ChangeNode;
  /** Owning schema artifact id, e.g. "specs". */
  artifactId?: string;
  /** Owning schema artifact label, e.g. "Specs". */
  artifactLabel?: string;
  /** Capability path, for spec documents. */
  specId?: string;
}

function walkSpecs(nodes: SpecNode[], out: DocRef[]): void {
  for (const node of nodes) {
    if (node.doc) {
      out.push({ doc: node.doc, section: "specs", specId: node.id });
    }
    walkSpecs(node.children, out);
  }
}

/** Every document in the tree, in display order. */
export function flatten(tree: ProjectTree): DocRef[] {
  const out: DocRef[] = [];
  for (const section of tree.sections) {
    switch (section.kind) {
      case "project":
        for (const doc of section.items) out.push({ doc, section: "project" });
        break;
      case "activeChanges":
      case "archive":
        for (const change of section.items) {
          for (const group of change.artifacts) {
            for (const doc of group.docs) {
              out.push({
                doc,
                section: section.kind,
                changeName: change.name,
                change,
                artifactId: group.id,
                artifactLabel: group.label,
              });
            }
          }
        }
        break;
      case "specs":
        walkSpecs(section.items, out);
        break;
    }
  }
  return out;
}

/** The reading sequence, ordered 1..N. */
export function readingSequence(tree: ProjectTree): DocRef[] {
  return flatten(tree).sort((a, b) => a.doc.seq - b.doc.seq);
}

export function findByPath(tree: ProjectTree, path: string): DocRef | undefined {
  return flatten(tree).find((r) => r.doc.path === path);
}

/** Neighbours of `path` in the reading sequence. */
export function neighbours(
  tree: ProjectTree,
  path: string | null,
): { prev: DocRef | null; next: DocRef | null; index: number; total: number } {
  const seq = readingSequence(tree);
  const index = path === null ? -1 : seq.findIndex((r) => r.doc.path === path);
  return {
    prev: index > 0 ? seq[index - 1] : null,
    next: index >= 0 && index < seq.length - 1 ? seq[index + 1] : null,
    index,
    total: seq.length,
  };
}

/** The first document worth opening when a project loads. */
export function firstDoc(tree: ProjectTree): DocRef | null {
  return readingSequence(tree)[0] ?? null;
}
