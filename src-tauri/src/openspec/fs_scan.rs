//! Reading a project by walking `openspec/` directly.
//!
//! This is the fallback source when the CLI is unavailable, and it also
//! supplies the parts the CLI does not report — archived changes and
//! project-level context files — to the CLI source.

use super::model::*;
use std::path::{Path, PathBuf};

pub fn openspec_dir(root: &Path) -> PathBuf {
    root.join("openspec")
}

/// Is this directory an OpenSpec project?
pub fn is_project(root: &Path) -> bool {
    openspec_dir(root).is_dir()
}

/// Directory entries, sorted by file name so output is deterministic.
fn sorted_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    out.sort();
    out
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Match an artifact's `generates` pattern against a change directory.
///
/// Patterns in practice are either a plain relative file (`proposal.md`) or a
/// directory glob (`specs/**/*.md`). Rather than pull in a full glob engine we
/// handle exactly those two shapes: everything up to the first `*` is a literal
/// directory to walk, and anything after the last `*` is a suffix to match.
fn resolve_pattern(change_dir: &Path, pattern: &str) -> Vec<PathBuf> {
    if !pattern.contains('*') {
        let p = change_dir.join(pattern);
        return if p.is_file() { vec![p] } else { Vec::new() };
    }

    let first_star = pattern.find('*').unwrap();
    let literal = &pattern[..first_star];
    let suffix = pattern.rsplit('*').next().unwrap_or("");
    let base = change_dir.join(literal.trim_end_matches('/'));

    let mut out: Vec<PathBuf> = walkdir::WalkDir::new(&base)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| suffix.is_empty() || p.to_string_lossy().ends_with(suffix))
        .collect();
    out.sort();
    out
}

/// Count `- [ ]` / `- [x]` checkboxes in a tasks document.
pub fn count_tasks(markdown: &str) -> (u32, u32) {
    let mut done = 0;
    let mut total = 0;
    for line in markdown.lines() {
        let t = line.trim_start();
        let t = t.strip_prefix("- ").or_else(|| t.strip_prefix("* "));
        let Some(t) = t else { continue };
        if let Some(rest) = t.strip_prefix('[') {
            let mut chars = rest.chars();
            let marker = chars.next();
            if chars.next() != Some(']') {
                continue;
            }
            match marker {
                Some(' ') => total += 1,
                Some('x') | Some('X') => {
                    total += 1;
                    done += 1;
                }
                _ => {}
            }
        }
    }
    (done, total)
}

/// Count `### Requirement:` headers in a spec document.
pub fn count_requirements(markdown: &str) -> u32 {
    markdown
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            t.starts_with("###") && t.to_lowercase().contains("requirement:")
        })
        .count() as u32
}

/// Derive a change's status from its task progress, mirroring how the CLI
/// labels changes so the scanner and CLI paths agree.
fn derive_status(done: u32, total: u32) -> String {
    match (done, total) {
        (_, 0) => "draft".to_string(),
        (d, t) if d >= t => "complete".to_string(),
        (0, _) => "draft".to_string(),
        _ => "in-progress".to_string(),
    }
}

/// Scan one change directory against the schema's artifact list.
pub fn scan_change(dir: &Path, schema: &SchemaInfo, archived_on: Option<String>) -> ChangeFacts {
    let artifacts: Vec<ArtifactFacts> = schema
        .artifacts
        .iter()
        .map(|def| {
            let existing = resolve_pattern(dir, &def.generates);
            ArtifactFacts {
                id: def.id.clone(),
                output_path: def.generates.clone(),
                status: Some(if existing.is_empty() { "pending" } else { "done" }.to_string()),
                requires: def.requires.clone(),
                existing_paths: existing,
            }
        })
        .collect();

    let tasks_md = artifacts
        .iter()
        .find(|a| a.id == "tasks")
        .and_then(|a| a.existing_paths.first())
        .and_then(|p| std::fs::read_to_string(p).ok());
    let (done, total) = tasks_md.as_deref().map(count_tasks).unwrap_or((0, 0));

    ChangeFacts {
        name: file_name(dir),
        dir: dir.to_path_buf(),
        status: Some(derive_status(done, total)),
        completed_tasks: Some(done),
        total_tasks: Some(total),
        last_modified: mtime_iso(dir),
        archived_on,
        artifacts,
    }
}

fn mtime_iso(path: &Path) -> Option<String> {
    let secs = std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(secs.to_string())
}

/// An archive directory is named `YYYY-MM-DD-<change-name>`; split the date off
/// so the UI can show it and sort by it.
fn split_archive_name(name: &str) -> (Option<String>, String) {
    let bytes = name.as_bytes();
    let looks_dated = bytes.len() > 11
        && bytes[..10]
            .iter()
            .enumerate()
            .all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
        && bytes[10] == b'-';
    if looks_dated {
        (Some(name[..10].to_string()), name[11..].to_string())
    } else {
        (None, name.to_string())
    }
}

pub fn scan_changes(root: &Path, schema: &SchemaInfo) -> Vec<ChangeFacts> {
    let dir = openspec_dir(root).join("changes");
    sorted_dirs(&dir)
        .into_iter()
        .filter(|p| file_name(p) != "archive")
        .map(|p| scan_change(&p, schema, None))
        .collect()
}

pub fn scan_archive(root: &Path, schema: &SchemaInfo) -> Vec<ChangeFacts> {
    let dir = openspec_dir(root).join("changes").join("archive");
    let mut out: Vec<ChangeFacts> = sorted_dirs(&dir)
        .into_iter()
        .map(|p| {
            let (date, name) = split_archive_name(&file_name(&p));
            let mut facts = scan_change(&p, schema, date);
            facts.name = name;
            facts
        })
        .collect();
    // Reverse chronological: most recently archived first. Undated entries sort
    // last, keeping their alphabetical order among themselves.
    out.sort_by(|a, b| match (&b.archived_on, &a.archived_on) {
        (Some(x), Some(y)) => x.cmp(y).then_with(|| a.name.cmp(&b.name)),
        (Some(_), None) => std::cmp::Ordering::Greater,
        (None, Some(_)) => std::cmp::Ordering::Less,
        (None, None) => a.name.cmp(&b.name),
    });
    out
}

/// Every `spec.md` under `openspec/specs`, keyed by its capability path.
pub fn scan_specs(root: &Path) -> Vec<SpecFacts> {
    let base = openspec_dir(root).join("specs");
    let mut out: Vec<SpecFacts> = walkdir::WalkDir::new(&base)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && e.file_name() == "spec.md")
        .filter_map(|e| {
            let path = e.into_path();
            let id = path
                .parent()?
                .strip_prefix(&base)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/");
            if id.is_empty() {
                return None;
            }
            let count = std::fs::read_to_string(&path)
                .ok()
                .map(|t| count_requirements(&t));
            Some(SpecFacts {
                id,
                path,
                requirement_count: count,
            })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Project-level context: the config plus any loose docs at the top of
/// `openspec/`, which is where conventions like `project.md` and `AGENTS.md`
/// live.
pub fn scan_context(root: &Path) -> Vec<ContextFacts> {
    let base = openspec_dir(root);
    let mut files: Vec<PathBuf> = std::fs::read_dir(&base)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            matches!(
                p.extension().and_then(|e| e.to_str()),
                Some("md" | "yaml" | "yml")
            )
        })
        .collect();

    // config.yaml first — it declares the schema everything else is ordered by.
    files.sort_by_key(|p| {
        let name = file_name(p);
        let rank = match name.as_str() {
            "config.yaml" | "config.yml" => 0,
            "project.md" => 1,
            "AGENTS.md" => 2,
            _ => 3,
        };
        (rank, name)
    });

    files
        .into_iter()
        .map(|path| ContextFacts {
            title: file_name(&path),
            path,
        })
        .collect()
}

/// Full scan: the fallback `Source` implementation.
pub fn facts(root: &Path, schema: &SchemaInfo) -> Facts {
    Facts {
        changes: scan_changes(root, schema),
        archived: scan_archive(root, schema),
        specs: scan_specs(root),
        context_files: scan_context(root),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_open_and_completed_tasks() {
        let md = "## 1. Backend\n- [x] 1.1 done\n- [ ] 1.2 open\n* [X] 1.3 also done\n- not a task\n";
        assert_eq!(count_tasks(md), (2, 3));
    }

    #[test]
    fn counts_no_tasks_in_a_document_without_checkboxes() {
        assert_eq!(count_tasks("## Plan\nSome prose.\n"), (0, 0));
    }

    #[test]
    fn counts_requirement_headers() {
        let md = "## ADDED Requirements\n### Requirement: One\ntext\n### Requirement: Two\n#### Scenario: s\n";
        assert_eq!(count_requirements(md), 2);
    }

    #[test]
    fn splits_the_date_prefix_off_an_archive_directory_name() {
        assert_eq!(
            split_archive_name("2026-08-12-add-search"),
            (Some("2026-08-12".to_string()), "add-search".to_string())
        );
        assert_eq!(
            split_archive_name("add-search"),
            (None, "add-search".to_string())
        );
    }

    #[test]
    fn resolves_a_plain_file_pattern_and_a_directory_glob() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("proposal.md"), "x").unwrap();
        let nested = dir.path().join("specs").join("identity").join("user-auth");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("spec.md"), "x").unwrap();

        assert_eq!(resolve_pattern(dir.path(), "proposal.md").len(), 1);
        assert!(resolve_pattern(dir.path(), "design.md").is_empty());

        let globbed = resolve_pattern(dir.path(), "specs/**/*.md");
        assert_eq!(globbed, vec![nested.join("spec.md")]);
    }

    #[test]
    fn derives_status_from_task_progress() {
        assert_eq!(derive_status(0, 0), "draft");
        assert_eq!(derive_status(0, 3), "draft");
        assert_eq!(derive_status(1, 3), "in-progress");
        assert_eq!(derive_status(3, 3), "complete");
    }

    #[test]
    fn finds_nested_capability_paths_as_slash_separated_ids() {
        let dir = tempfile::tempdir().unwrap();
        let specs = dir.path().join("openspec").join("specs");
        std::fs::create_dir_all(specs.join("billing")).unwrap();
        std::fs::create_dir_all(specs.join("identity").join("user-auth")).unwrap();
        std::fs::write(specs.join("billing").join("spec.md"), "### Requirement: a\n").unwrap();
        std::fs::write(
            specs.join("identity").join("user-auth").join("spec.md"),
            "### Requirement: a\n### Requirement: b\n",
        )
        .unwrap();

        let found = scan_specs(dir.path());
        let ids: Vec<_> = found.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["billing", "identity/user-auth"]);
        assert_eq!(found[1].requirement_count, Some(2));
    }

    #[test]
    fn orders_archive_most_recent_first() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("openspec").join("changes").join("archive");
        for name in ["2026-01-05-early", "2026-08-12-late", "undated-change"] {
            std::fs::create_dir_all(archive.join(name)).unwrap();
            std::fs::write(archive.join(name).join("proposal.md"), "x").unwrap();
        }
        let schema = SchemaInfo {
            name: "spec-driven".into(),
            description: None,
            artifacts: default_test_artifacts(),
            assumed: false,
        };
        let found = scan_archive(dir.path(), &schema);
        let names: Vec<_> = found.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["late", "early", "undated-change"]);
    }

    #[test]
    fn excludes_the_archive_directory_from_active_changes() {
        let dir = tempfile::tempdir().unwrap();
        let changes = dir.path().join("openspec").join("changes");
        std::fs::create_dir_all(changes.join("archive").join("2026-01-01-old")).unwrap();
        std::fs::create_dir_all(changes.join("add-auth")).unwrap();
        let schema = SchemaInfo {
            name: "spec-driven".into(),
            description: None,
            artifacts: default_test_artifacts(),
            assumed: false,
        };
        let found = scan_changes(dir.path(), &schema);
        let names: Vec<_> = found.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["add-auth"]);
    }

    fn default_test_artifacts() -> Vec<ArtifactDef> {
        vec![
            ArtifactDef {
                id: "proposal".into(),
                generates: "proposal.md".into(),
                description: None,
                requires: vec![],
            },
            ArtifactDef {
                id: "tasks".into(),
                generates: "tasks.md".into(),
                description: None,
                requires: vec!["proposal".into()],
            },
        ]
    }
}
