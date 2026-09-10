//! The CLI-backed and scanner-backed sources must agree on structure and
//! ordering. If they drift, the fallback silently reorders a reader's docs —
//! the one failure mode that would be hard to notice, so it gets a test.
//!
//! Volatile metadata (timestamps, status wording) is expected to differ and is
//! not compared; document identity, kind, schema step and reading sequence are.

use speck_lib::openspec::{self, model::*};
use std::path::Path;

/// A fixture project exercising the shapes that matter: several changes, a
/// half-written change, nested capability paths, and an archive.
fn fixture(root: &Path) {
    let os = root.join("openspec");
    let write = |p: std::path::PathBuf, body: &str| {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    };

    write(os.join("config.yaml"), "schema: spec-driven\n");
    write(os.join("project.md"), "# Project\nContext here.\n");

    // A complete change with two delta specs, one of them nested.
    let c1 = os.join("changes").join("add-user-auth");
    write(c1.join("proposal.md"), "## Why\nNo auth.\n");
    write(
        c1.join("specs").join("identity").join("user-auth").join("spec.md"),
        "## ADDED Requirements\n### Requirement: Login\nUsers SHALL log in.\n\n#### Scenario: ok\n- **WHEN** valid\n- **THEN** token\n",
    );
    write(
        c1.join("specs").join("billing").join("spec.md"),
        "## MODIFIED Requirements\n### Requirement: Invoices\nChanged.\n",
    );
    write(c1.join("design.md"), "## Context\nJWT.\n");
    write(c1.join("tasks.md"), "## 1. Work\n- [x] 1.1 a\n- [ ] 1.2 b\n");

    // A change with only a proposal: design and tasks are not written yet.
    let c2 = os.join("changes").join("add-export");
    write(c2.join("proposal.md"), "## Why\nExports.\n");

    // Archived changes, deliberately not in chronological order on disk.
    let a1 = os.join("changes").join("archive").join("2026-01-05-early-thing");
    write(a1.join("proposal.md"), "## Why\nEarly.\n");
    let a2 = os.join("changes").join("archive").join("2026-08-12-late-thing");
    write(a2.join("proposal.md"), "## Why\nLate.\n");

    // Current specs.
    write(
        os.join("specs").join("billing").join("spec.md"),
        "# billing\n## Requirements\n### Requirement: Invoices\nMonthly.\n",
    );
    write(
        os.join("specs").join("identity").join("user-auth").join("spec.md"),
        "# user-auth\n## Requirements\n### Requirement: Login\nEmail.\n### Requirement: Logout\nToken.\n",
    );
}

/// The comparable shape of a tree: identity, kind, artifact step and sequence,
/// in display order, plus the artifact grouping of every change.
#[derive(Debug, PartialEq)]
struct Shape {
    docs: Vec<(String, DocKind, Option<u32>, u32)>,
    changes: Vec<String>,
    /// `<change>/<step> <label>` with the count of files under it, and whether
    /// the artifact is unwritten.
    groups: Vec<String>,
    archive: Vec<String>,
    specs: Vec<String>,
    doc_count: u32,
}

type DocRow = (String, DocKind, Option<u32>, u32);

fn shape(tree: &ProjectTree) -> Shape {
    let mut docs: Vec<DocRow> = Vec::new();
    let mut changes = Vec::new();
    let mut groups = Vec::new();
    let mut archive = Vec::new();
    let mut specs = Vec::new();

    fn walk_specs(nodes: &[SpecNode], ids: &mut Vec<String>, docs: &mut Vec<DocRow>) {
        for n in nodes {
            ids.push(n.id.clone());
            if let Some(d) = &n.doc {
                docs.push((d.id.clone(), d.kind, None, d.seq));
            }
            walk_specs(&n.children, ids, docs);
        }
    }

    fn walk_change(c: &ChangeNode, groups: &mut Vec<String>, docs: &mut Vec<DocRow>) {
        for g in &c.artifacts {
            groups.push(format!(
                "{}/{} {} n={} missing={} nested={} tasks={:?}/{:?} state={:?}",
                c.name,
                g.step,
                g.label,
                g.docs.len(),
                g.missing,
                g.nested,
                g.completed_tasks,
                g.total_tasks,
                g.state
            ));
            for d in &g.docs {
                docs.push((d.id.clone(), d.kind, Some(g.step), d.seq));
            }
        }
    }

    for section in &tree.sections {
        match section {
            Section::Project(ds) => {
                for d in ds {
                    docs.push((d.id.clone(), d.kind, None, d.seq));
                }
            }
            Section::ActiveChanges(cs) => {
                for c in cs {
                    changes.push(c.name.clone());
                    walk_change(c, &mut groups, &mut docs);
                }
            }
            Section::Archive(cs) => {
                for c in cs {
                    archive.push(c.name.clone());
                    walk_change(c, &mut groups, &mut docs);
                }
            }
            Section::Specs(ns) => walk_specs(ns, &mut specs, &mut docs),
        }
    }

    Shape {
        docs,
        changes,
        groups,
        archive,
        specs,
        doc_count: tree.doc_count,
    }
}

fn scanner_tree(root: &Path) -> ProjectTree {
    let mut warnings = Vec::new();
    let schema = openspec::schema::resolve(root, &mut warnings);
    let facts = openspec::fs_scan::facts(root, &schema);
    openspec::tree::build(root, schema, &facts, SourceKind::Scanner, warnings)
}

#[test]
fn scanner_reads_the_fixture_in_lifecycle_and_schema_order() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    fixture(&root);

    let tree = scanner_tree(&root);
    let s = shape(&tree);

    // Active changes: most recent first, both present.
    assert_eq!(s.changes.len(), 2);
    assert!(s.changes.contains(&"add-user-auth".to_string()));
    assert!(s.changes.contains(&"add-export".to_string()));

    // Archive is reverse-chronological, with the date prefix stripped.
    assert_eq!(s.archive, vec!["late-thing", "early-thing"]);

    // Specs nest, intermediate segments included.
    assert_eq!(s.specs, vec!["billing", "identity", "identity/user-auth"]);

    // The complete change groups into all four artifacts, with both delta specs
    // under the one `Specs` group.
    assert_eq!(
        s.groups
            .iter()
            .filter(|g| g.starts_with("add-user-auth/"))
            .cloned()
            .collect::<Vec<_>>(),
        vec![
            "add-user-auth/1 Proposal n=1 missing=false nested=false tasks=None/None state=Complete",
            "add-user-auth/2 Specs n=2 missing=false nested=true tasks=None/None state=Complete",
            "add-user-auth/3 Design n=1 missing=false nested=false tasks=None/None state=Complete",
            "add-user-auth/4 Tasks n=1 missing=false nested=false tasks=Some(1)/Some(2) state=Current",
        ]
    );

    let auth_kinds: Vec<_> = s
        .docs
        .iter()
        .filter(|(id, ..)| id.contains("changes/add-user-auth"))
        .map(|(_, k, ..)| *k)
        .collect();
    assert_eq!(
        auth_kinds,
        vec![
            DocKind::Proposal,
            DocKind::SpecDelta,
            DocKind::SpecDelta,
            DocKind::Design,
            DocKind::Tasks
        ]
    );

    // The half-written change keeps all four steps, three of them marked
    // missing and holding no documents.
    assert_eq!(
        s.groups
            .iter()
            .filter(|g| g.starts_with("add-export/"))
            .cloned()
            .collect::<Vec<_>>(),
        vec![
            "add-export/1 Proposal n=1 missing=false nested=false tasks=None/None state=Current",
            "add-export/2 Specs n=0 missing=true nested=true tasks=None/None state=Pending",
            "add-export/3 Design n=0 missing=true nested=false tasks=None/None state=Pending",
            "add-export/4 Tasks n=0 missing=true nested=false tasks=Some(0)/Some(0) state=Pending",
        ]
    );

    // The reading sequence is a contiguous 1..N.
    let mut seqs: Vec<u32> = s.docs.iter().map(|(_, _, _, seq)| *seq).collect();
    seqs.sort();
    assert_eq!(seqs, (1..=s.doc_count).collect::<Vec<_>>());
    assert_eq!(
        s.doc_count, 12,
        "2 context + 5 auth + 1 export + 2 archived + 2 specs"
    );
}

#[test]
fn cli_and_scanner_agree_on_structure_and_ordering() {
    if openspec::cli::binary().is_none() {
        eprintln!("skipping: openspec CLI not installed");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    fixture(&root);

    let cli_tree = openspec::load(&root).unwrap();
    // If the CLI could not be read, this test has nothing to compare.
    if cli_tree.source != SourceKind::Cli {
        eprintln!("skipping: CLI read degraded: {:?}", cli_tree.warnings);
        return;
    }
    let scan_tree = scanner_tree(&root);

    assert_eq!(
        shape(&cli_tree),
        shape(&scan_tree),
        "CLI and scanner disagree on document structure or ordering"
    );
    assert_eq!(cli_tree.schema.artifacts, scan_tree.schema.artifacts);
}
