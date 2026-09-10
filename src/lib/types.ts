// Mirrors the Rust domain model in src-tauri/src/openspec/model.rs.
// Kept hand-written and small rather than generated: the surface is a handful
// of types and the duplication is cheaper than a codegen step.

export type DocKind =
  | "context"
  | "proposal"
  | "specDelta"
  | "design"
  | "tasks"
  | "spec"
  | "other";

export type SourceKind = "cli" | "scanner";

export interface ArtifactDef {
  id: string;
  generates: string;
  description: string | null;
  requires: string[];
}

export interface SchemaInfo {
  name: string;
  description: string | null;
  artifacts: ArtifactDef[];
  /** True when the schema definition could not be read and a built-in order is in use. */
  assumed: boolean;
}

/** A document that exists on disk. Unwritten artifacts are represented by
 *  their {@link ArtifactGroup}, so every Doc here is readable. */
export interface Doc {
  id: string;
  title: string;
  path: string;
  kind: DocKind;
  /** Position in the project-wide reading sequence, 1-based. */
  seq: number;
}

/** How far a change has got with one artifact. A written document does not
 *  finish the step: it is complete only once work has moved past it. */
export type ArtifactState = "pending" | "current" | "complete";

/** One artifact of the project's schema within a change — the level OpenSpec
 *  itself defines (proposal, specs, design, tasks). */
export interface ArtifactGroup {
  id: string;
  label: string;
  /** 1-based position in schema order. */
  step: number;
  status: string | null;
  docs: Doc[];
  /** The schema expects this artifact but nothing is written yet. */
  missing: boolean;
  /** Documents are identified by capability path, so listing them under the
   *  artifact adds information. False for a single-file artifact like
   *  `proposal`, whose label already names it. */
  nested: boolean;
  /** Checklist progress, present only on the artifact holding the tasks. */
  completedTasks: number | null;
  totalTasks: number | null;
  state: ArtifactState;
}

export interface ChangeNode {
  name: string;
  status: string | null;
  completedTasks: number | null;
  totalTasks: number | null;
  lastModified: string | null;
  archivedOn: string | null;
  /** Artifacts in schema order, written or not. */
  artifacts: ArtifactGroup[];
}

export interface SpecNode {
  id: string;
  label: string;
  requirementCount: number | null;
  doc: Doc | null;
  children: SpecNode[];
}

export type Section =
  | { kind: "project"; items: Doc[] }
  | { kind: "activeChanges"; items: ChangeNode[] }
  | { kind: "specs"; items: SpecNode[] }
  | { kind: "archive"; items: ChangeNode[] };

export interface ProjectTree {
  root: string;
  name: string;
  schema: SchemaInfo;
  source: SourceKind;
  warnings: string[];
  sections: Section[];
  docCount: number;
}

export interface DocContent {
  id: string;
  path: string;
  markdown: string;
  mtimeMs: number | null;
}

export interface ProjectEntry {
  path: string;
  name: string;
  addedAt: number;
  lastOpened: number | null;
  available: boolean;
  storeId: string | null;
}

export interface ChangedPayload {
  root: string;
  paths: string[];
}

export const SECTION_LABELS: Record<Section["kind"], string> = {
  project: "Project",
  activeChanges: "Active changes",
  specs: "Current specs",
  archive: "Archive",
};
