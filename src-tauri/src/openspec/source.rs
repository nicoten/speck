//! The seam between "ask the CLI" and "walk the tree ourselves".
//!
//! `load` is the only entry point the rest of the app uses. It prefers the CLI,
//! because the CLI defines document order and change status, and degrades to the
//! built-in scanner when the CLI is missing or answers with something we cannot
//! read — surfacing that in `ProjectTree::warnings` rather than failing.

use super::model::*;
use super::{cli, fs_scan, schema, tree};
use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};

/// Assemble facts by asking the CLI.
///
/// Archived changes and project context files come from the filesystem in both
/// paths: `openspec status` covers active changes only.
fn cli_facts(root: &Path, schema: &SchemaInfo, warnings: &mut Vec<String>) -> Result<Facts> {
    // Three independent calls, each ~100-200ms; run them together.
    let (status, changes, specs) = std::thread::scope(|s| {
        let a = s.spawn(|| cli::status_all(root));
        let b = s.spawn(|| cli::list_changes(root));
        let c = s.spawn(|| cli::list_specs(root));
        (
            a.join().map_err(|_| anyhow!("status thread panicked")),
            b.join().map_err(|_| anyhow!("list thread panicked")),
            c.join().map_err(|_| anyhow!("specs thread panicked")),
        )
    });

    let status = status??;
    let changes = changes??;
    let specs = specs??;

    let changes_dir = fs_scan::openspec_dir(root).join("changes");

    let mut change_facts: Vec<ChangeFacts> = Vec::new();
    for entry in &changes.changes {
        let dir = status
            .changes
            .iter()
            .find(|c| c.change_name == entry.name)
            .and_then(|c| c.change_root.as_ref())
            .map(PathBuf::from)
            .unwrap_or_else(|| changes_dir.join(&entry.name));

        let artifacts = match status.changes.iter().find(|c| c.change_name == entry.name) {
            Some(sc) if !sc.artifacts.is_empty() => sc
                .artifacts
                .iter()
                .map(|a| {
                    let mut existing: Vec<PathBuf> = sc
                        .artifact_paths
                        .get(&a.id)
                        .map(|p| p.existing_output_paths.iter().map(PathBuf::from).collect())
                        .unwrap_or_default();
                    existing.sort();
                    ArtifactFacts {
                        id: a.id.clone(),
                        output_path: a.output_path.clone(),
                        status: a.status.clone(),
                        requires: a.requires.clone(),
                        existing_paths: existing,
                    }
                })
                .collect(),
            // The CLI listed the change but reported no artifacts for it; scan
            // that one change rather than dropping it from the tree.
            _ => {
                warnings.push(format!(
                    "No artifact status reported for change '{}'; read from disk instead.",
                    entry.name
                ));
                fs_scan::scan_change(&dir, schema, None).artifacts
            }
        };

        change_facts.push(ChangeFacts {
            name: entry.name.clone(),
            dir,
            status: entry.status.clone(),
            completed_tasks: entry.completed_tasks,
            total_tasks: entry.total_tasks,
            last_modified: entry.last_modified.clone(),
            archived_on: None,
            artifacts,
        });
    }

    let specs_dir = fs_scan::openspec_dir(root).join("specs");
    let spec_facts: Vec<SpecFacts> = specs
        .specs
        .iter()
        .map(|s| SpecFacts {
            id: s.id.clone(),
            path: specs_dir.join(&s.id).join("spec.md"),
            requirement_count: s.requirement_count,
        })
        .collect();

    Ok(Facts {
        changes: change_facts,
        archived: fs_scan::scan_archive(root, schema),
        specs: spec_facts,
        context_files: fs_scan::scan_context(root),
    })
}

/// Load a project, preferring the CLI and falling back to the scanner.
pub fn load(root: &Path) -> Result<ProjectTree> {
    if !fs_scan::is_project(root) {
        return Err(anyhow!(
            "{} is not an OpenSpec project (no openspec/ directory)",
            root.display()
        ));
    }

    let mut warnings = Vec::new();
    let schema = schema::resolve(root, &mut warnings);

    if cli::binary().is_some() {
        match cli_facts(root, &schema, &mut warnings) {
            Ok(facts) => {
                return Ok(tree::build(
                    root,
                    schema,
                    &facts,
                    SourceKind::Cli,
                    warnings,
                ))
            }
            Err(e) => warnings.push(format!(
                "The openspec CLI could not be read ({e}); showing results from the built-in scanner."
            )),
        }
    } else {
        warnings.push(
            "The openspec CLI was not found on this machine; showing results from the built-in scanner."
                .to_string(),
        );
    }

    let facts = fs_scan::facts(root, &schema);
    Ok(tree::build(
        root,
        schema,
        &facts,
        SourceKind::Scanner,
        warnings,
    ))
}
