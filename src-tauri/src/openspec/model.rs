//! Domain model for a rendered OpenSpec project.
//!
//! `Facts` is the raw material a [`Source`](super::source::Source) produces; the
//! `ProjectTree` below is what the UI consumes. Keeping them separate is what lets
//! the CLI-backed and filesystem-backed sources share all of the ordering logic.

use serde::{Deserialize, Serialize};

/// One artifact as declared by the project's workflow schema, in schema order.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDef {
    pub id: String,
    /// Path (or glob) the artifact generates, relative to the change directory.
    pub generates: String,
    pub description: Option<String>,
    /// Artifact ids this one depends on.
    pub requires: Vec<String>,
}

/// The workflow schema a project declares in `openspec/config.yaml`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
    pub description: Option<String>,
    pub artifacts: Vec<ArtifactDef>,
    /// True when the schema definition could not be read and a built-in
    /// fallback order is being used instead.
    pub assumed: bool,
}

// ---------------------------------------------------------------------------
// Facts: what a source discovers about a project
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Facts {
    pub changes: Vec<ChangeFacts>,
    pub archived: Vec<ChangeFacts>,
    pub specs: Vec<SpecFacts>,
    /// Loose docs at the top of `openspec/` (project.md, AGENTS.md, ...).
    pub context_files: Vec<ContextFacts>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChangeFacts {
    pub name: String,
    /// Directory holding the change, absolute.
    pub dir: std::path::PathBuf,
    pub status: Option<String>,
    pub completed_tasks: Option<u32>,
    pub total_tasks: Option<u32>,
    pub last_modified: Option<String>,
    /// Archive directories are prefixed `YYYY-MM-DD-`; this is that prefix.
    pub archived_on: Option<String>,
    pub artifacts: Vec<ArtifactFacts>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactFacts {
    pub id: String,
    pub output_path: String,
    /// `done` / `pending` as reported by `openspec status`, when available.
    pub status: Option<String>,
    pub requires: Vec<String>,
    /// Files that actually exist for this artifact, absolute.
    pub existing_paths: Vec<std::path::PathBuf>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpecFacts {
    /// Capability path relative to `openspec/specs`, e.g. `identity/user-auth`.
    pub id: String,
    pub path: std::path::PathBuf,
    pub requirement_count: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContextFacts {
    pub title: String,
    pub path: std::path::PathBuf,
}

// ---------------------------------------------------------------------------
// ProjectTree: what the UI consumes
// ---------------------------------------------------------------------------

/// What role a document plays. Drives the reader's rendering mode.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DocKind {
    /// Project-level context (config.yaml, project.md, AGENTS.md).
    Context,
    Proposal,
    /// A delta spec inside a change.
    SpecDelta,
    Design,
    Tasks,
    /// A spec under `openspec/specs` — current truth.
    Spec,
    Other,
}

/// A document that exists on disk. Every `Doc` is readable; an artifact the
/// schema expects but that has not been written is represented by its
/// [`ArtifactGroup`] instead, so no placeholder ever reaches the reader.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    /// Stable identity: the path relative to the project root.
    pub id: String,
    pub title: String,
    pub path: String,
    pub kind: DocKind,
    /// Position in the project-wide reading sequence, 1-based.
    pub seq: u32,
}

/// How far a change has got with one artifact.
///
/// Writing a document does not finish the step: a proposal is only settled once
/// the work has moved past it. So a step counts as complete when a later step
/// has started, and the final step relies on its own signal — for `tasks`, every
/// box ticked.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactState {
    /// Nothing written yet.
    Pending,
    /// Written, and the furthest the change has got.
    Current,
    /// Settled: a later step has started, or its own criterion is met.
    Complete,
}

/// One artifact of the project's schema, within a change.
///
/// This is the level the schema itself defines — `proposal`, `specs`, `design`,
/// `tasks` — so the tree mirrors OpenSpec's own shape rather than flattening a
/// multi-file artifact into siblings of the single-file ones.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactGroup {
    /// Schema artifact id, e.g. `specs`.
    pub id: String,
    /// Display label derived from the id, e.g. `Specs`.
    pub label: String,
    /// 1-based position in schema order.
    pub step: u32,
    /// `done` / `pending` as reported by `openspec status`, when known.
    pub status: Option<String>,
    /// The files satisfying this artifact, in order. Empty when unwritten.
    pub docs: Vec<Doc>,
    /// True when the schema expects this artifact but nothing exists yet.
    pub missing: bool,
    /// True when the documents are identified by capability path rather than by
    /// file name, so listing them under the artifact adds information. False for
    /// a single-file artifact like `proposal`, where the label says it all.
    pub nested: bool,
    /// Checklist progress, set only on the artifact that holds the tasks, so
    /// the count sits on the row that owns it.
    pub completed_tasks: Option<u32>,
    pub total_tasks: Option<u32>,
    /// Progress through this step. See [`ArtifactState`].
    pub state: ArtifactState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeNode {
    pub name: String,
    pub status: Option<String>,
    pub completed_tasks: Option<u32>,
    pub total_tasks: Option<u32>,
    pub last_modified: Option<String>,
    pub archived_on: Option<String>,
    /// Artifacts in schema order, written or not.
    pub artifacts: Vec<ArtifactGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpecNode {
    pub id: String,
    /// Last path segment, for display.
    pub label: String,
    pub requirement_count: Option<u32>,
    /// `None` for an intermediate path segment that has no `spec.md` of its own
    /// (e.g. `identity` when only `identity/user-auth` is specified).
    pub doc: Option<Doc>,
    /// Nested capabilities beneath this path segment.
    pub children: Vec<SpecNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind", content = "items")]
pub enum Section {
    /// Project-level context documents.
    Project(Vec<Doc>),
    ActiveChanges(Vec<ChangeNode>),
    Specs(Vec<SpecNode>),
    Archive(Vec<ChangeNode>),
}

/// How the project's facts were obtained. Surfaced in the UI so a degraded
/// read is visible rather than silent.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    /// `openspec` CLI answered.
    Cli,
    /// Built-in scanner; the CLI was unavailable or unusable.
    Scanner,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTree {
    /// Absolute project root (the directory containing `openspec/`).
    pub root: String,
    pub name: String,
    pub schema: SchemaInfo,
    pub source: SourceKind,
    /// Non-fatal problems worth showing the reader.
    pub warnings: Vec<String>,
    pub sections: Vec<Section>,
    /// Total docs in the reading sequence.
    pub doc_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocContent {
    pub id: String,
    pub path: String,
    pub markdown: String,
    /// Milliseconds since the epoch, for change detection.
    pub mtime_ms: Option<u64>,
}
