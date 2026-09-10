//! Resolving a project's workflow schema, which defines document order.
//!
//! Order of preference:
//!   1. a project-local `openspec/schemas/<name>/schema.yaml`
//!   2. the schema that shipped with the CLI, located via `openspec templates`
//!   3. `openspec schemas --json`, which gives ordered artifact ids but no
//!      `requires` edges
//!   4. a built-in default, flagged `assumed` so the UI can say so
//!
//! Only step 4 hardcodes an order, and it is the last resort.

use super::cli;
use super::model::{ArtifactDef, SchemaInfo};
use anyhow::Result;
use serde::Deserialize;
use std::path::{Path, PathBuf};

pub const DEFAULT_SCHEMA: &str = "spec-driven";

/// The stock `spec-driven` order, used only when nothing else can be read.
fn default_artifacts() -> Vec<ArtifactDef> {
    let def = |id: &str, generates: &str, requires: &[&str]| ArtifactDef {
        id: id.to_string(),
        generates: generates.to_string(),
        description: None,
        requires: requires.iter().map(|s| s.to_string()).collect(),
    };
    vec![
        def("proposal", "proposal.md", &[]),
        def("specs", "specs/**/*.md", &["proposal"]),
        def("design", "design.md", &["proposal"]),
        def("tasks", "tasks.md", &["specs", "design"]),
    ]
}

/// The subset of `openspec/config.yaml` we care about.
#[derive(Debug, Deserialize, Default)]
struct Config {
    schema: Option<String>,
    /// Prose the project shows its agents: stack, conventions, domain.
    context: Option<String>,
}

fn read_config(root: &Path) -> Option<Config> {
    let text = std::fs::read_to_string(root.join("openspec").join("config.yaml")).ok()?;
    serde_yaml_ng::from_str(&text).ok()
}

/// The project's own description of itself, as written in `config.yaml`.
pub fn project_context(root: &Path) -> Option<String> {
    read_config(root)?
        .context
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
}

/// A schema definition file.
#[derive(Debug, Deserialize)]
struct SchemaFile {
    name: Option<String>,
    description: Option<String>,
    #[serde(default)]
    artifacts: Vec<SchemaFileArtifact>,
}

#[derive(Debug, Deserialize)]
struct SchemaFileArtifact {
    id: String,
    #[serde(default)]
    generates: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    requires: Vec<String>,
}

/// Read the schema name a project declares. Defaults to `spec-driven`, which is
/// what the CLI itself assumes when `config.yaml` omits the key.
pub fn schema_name(root: &Path) -> String {
    read_config(root)
        .and_then(|c| c.schema)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_SCHEMA.to_string())
}

pub fn parse_schema_yaml(text: &str, fallback_name: &str) -> Result<SchemaInfo> {
    let file: SchemaFile = serde_yaml_ng::from_str(text)?;
    let artifacts = file
        .artifacts
        .into_iter()
        .map(|a| ArtifactDef {
            generates: a.generates.unwrap_or_else(|| format!("{}.md", a.id)),
            id: a.id,
            description: a.description,
            requires: a.requires,
        })
        .collect::<Vec<_>>();

    if artifacts.is_empty() {
        anyhow::bail!("schema declares no artifacts");
    }
    Ok(SchemaInfo {
        name: file.name.unwrap_or_else(|| fallback_name.to_string()),
        description: file.description,
        artifacts,
        assumed: false,
    })
}

/// Where a project may keep its own schema definitions.
fn local_schema_path(root: &Path, name: &str) -> PathBuf {
    root.join("openspec")
        .join("schemas")
        .join(name)
        .join("schema.yaml")
}

/// Derive the packaged schema definition path from a resolved template path.
///
/// `openspec templates --json` returns paths like
/// `<pkg>/schemas/spec-driven/templates/proposal.md`; the definition sits two
/// levels up. Deriving it this way avoids guessing where the CLI is installed.
fn packaged_schema_path(template_path: &str) -> Option<PathBuf> {
    let p = Path::new(template_path);
    // .../schemas/<name>/templates/<file>.md -> .../schemas/<name>/schema.yaml
    let schema_dir = p.parent()?.parent()?;
    let candidate = schema_dir.join("schema.yaml");
    candidate.exists().then_some(candidate)
}

/// What a resolved schema was resolved against: `openspec/config.yaml`'s
/// modification time and size, or `None` where the file is absent — which is
/// itself a state to invalidate on, since writing one changes the answer.
type Stamp = Option<(std::time::SystemTime, u64)>;

fn config_stamp(root: &Path) -> Stamp {
    let m = std::fs::metadata(root.join("openspec").join("config.yaml")).ok()?;
    Some((m.modified().ok()?, m.len()))
}

struct Cached {
    stamp: Stamp,
    info: SchemaInfo,
    warnings: Vec<String>,
}

/// Resolving a schema costs a CLI process spawn — over half a second measured
/// on a real project — and every project reload does it, which means every time
/// an agent or an editor touches a file while you read. The answer changes only
/// when the project says it uses a different schema, so it is kept until
/// `config.yaml` does.
///
/// Held for the life of the process: upgrading the `openspec` package under a
/// running app keeps the old answer until it restarts, which is a fair trade
/// for not paying the spawn on every keystroke an agent makes.
static CACHE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, Cached>>,
> = std::sync::LazyLock::new(Default::default);

/// `load` the schema unless the cached answer was resolved against the same
/// `config.yaml`, replaying its warnings either way so a cached answer still
/// says how it degraded.
fn cached<F>(root: &Path, warnings: &mut Vec<String>, load: F) -> SchemaInfo
where
    F: FnOnce(&Path, &mut Vec<String>) -> SchemaInfo,
{
    let stamp = config_stamp(root);

    if let Some(hit) = CACHE.lock().unwrap().get(root) {
        if hit.stamp == stamp {
            warnings.extend(hit.warnings.iter().cloned());
            return hit.info.clone();
        }
    }

    // Collected separately so a replay from the cache carries exactly the
    // warnings this resolution produced, not whatever else the caller had.
    let mut fresh = Vec::new();
    let info = load(root, &mut fresh);

    CACHE.lock().unwrap().insert(
        root.to_path_buf(),
        Cached {
            stamp,
            info: info.clone(),
            warnings: fresh.clone(),
        },
    );
    warnings.extend(fresh);
    info
}

/// Resolve the full schema for a project, with `warnings` collecting anything
/// that degraded along the way. Answered from the cache while the project's
/// `config.yaml` is unchanged.
pub fn resolve(root: &Path, warnings: &mut Vec<String>) -> SchemaInfo {
    cached(root, warnings, resolve_uncached)
}

fn resolve_uncached(root: &Path, warnings: &mut Vec<String>) -> SchemaInfo {
    let name = schema_name(root);

    // 1. Project-local definition wins: a project that ships its own schema
    //    means its order, not the package default.
    let local = local_schema_path(root, &name);
    if local.exists() {
        match std::fs::read_to_string(&local).map_err(anyhow::Error::from) {
            Ok(text) => match parse_schema_yaml(&text, &name) {
                Ok(info) => return info,
                Err(e) => warnings.push(format!("Could not parse {}: {e}", local.display())),
            },
            Err(e) => warnings.push(format!("Could not read {}: {e}", local.display())),
        }
    }

    // 2. The definition that shipped with the CLI.
    if let Ok(templates) = cli::templates(root, &name) {
        if let Some(path) = templates.values().find_map(|t| packaged_schema_path(t)) {
            if let Ok(text) = std::fs::read_to_string(&path) {
                match parse_schema_yaml(&text, &name) {
                    Ok(info) => return info,
                    Err(e) => warnings.push(format!("Could not parse {}: {e}", path.display())),
                }
            }
        }
    }

    // 3. Ordered artifact ids without dependency edges.
    if let Ok(list) = cli::schemas(root) {
        if let Some(s) = list.into_iter().find(|s| s.name == name) {
            if !s.artifacts.is_empty() {
                return SchemaInfo {
                    name: s.name,
                    description: s.description,
                    artifacts: s
                        .artifacts
                        .into_iter()
                        .map(|id| ArtifactDef {
                            generates: if id == "specs" {
                                "specs/**/*.md".to_string()
                            } else {
                                format!("{id}.md")
                            },
                            id,
                            description: None,
                            requires: Vec::new(),
                        })
                        .collect(),
                    assumed: false,
                };
            }
        }
    }

    // 4. Built-in order, clearly flagged.
    warnings.push(format!(
        "Could not read the definition for schema '{name}'; using the built-in spec-driven order."
    ));
    SchemaInfo {
        name,
        description: None,
        artifacts: default_artifacts(),
        assumed: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A project whose `config.yaml` says `text`.
    fn project(text: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("openspec")).unwrap();
        std::fs::write(dir.path().join("openspec").join("config.yaml"), text).unwrap();
        dir
    }

    #[test]
    fn resolves_once_and_then_answers_from_the_cache() {
        // Every project reload asked the CLI where the packaged schema lives,
        // which cost more than half a second to re-answer a question whose
        // answer had not changed.
        let dir = project("schema: spec-driven\n");
        let calls = AtomicUsize::new(0);
        let load = |_: &Path, _: &mut Vec<String>| {
            calls.fetch_add(1, Ordering::SeqCst);
            SchemaInfo {
                name: "spec-driven".into(),
                description: None,
                artifacts: default_artifacts(),
                assumed: false,
            }
        };

        let mut warnings = Vec::new();
        let first = cached(dir.path(), &mut warnings, load);
        let second = cached(dir.path(), &mut warnings, load);

        assert_eq!(calls.load(Ordering::SeqCst), 1, "the second call resolved again");
        assert_eq!(first, second);
    }

    #[test]
    fn resolves_again_once_config_yaml_changes() {
        let dir = project("schema: spec-driven\n");
        let calls = AtomicUsize::new(0);
        let load = |_: &Path, _: &mut Vec<String>| {
            calls.fetch_add(1, Ordering::SeqCst);
            SchemaInfo {
                name: "spec-driven".into(),
                description: None,
                artifacts: default_artifacts(),
                assumed: false,
            }
        };

        let mut warnings = Vec::new();
        cached(dir.path(), &mut warnings, load);
        std::fs::write(
            dir.path().join("openspec").join("config.yaml"),
            "schema: something-else\n",
        )
        .unwrap();
        cached(dir.path(), &mut warnings, load);

        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "a rewritten config.yaml must not be answered from the cache"
        );
    }

    #[test]
    fn a_cached_answer_still_reports_how_it_degraded() {
        // The warnings are how the window says it fell back to a built-in
        // order. Caching the schema must not silently drop them.
        let dir = project("schema: spec-driven\n");
        let load = |_: &Path, w: &mut Vec<String>| {
            w.push("could not read the definition".to_string());
            SchemaInfo {
                name: "spec-driven".into(),
                description: None,
                artifacts: default_artifacts(),
                assumed: true,
            }
        };

        let mut first = Vec::new();
        cached(dir.path(), &mut first, load);
        let mut second = Vec::new();
        cached(dir.path(), &mut second, load);

        assert_eq!(first, vec!["could not read the definition".to_string()]);
        assert_eq!(second, first, "the cached answer lost its warning");
    }

    #[test]
    fn projects_do_not_share_a_cached_schema() {
        let a = project("schema: alpha\n");
        let b = project("schema: beta\n");
        let load = |root: &Path, _: &mut Vec<String>| SchemaInfo {
            name: schema_name(root),
            description: None,
            artifacts: default_artifacts(),
            assumed: false,
        };

        let mut warnings = Vec::new();
        assert_eq!(cached(a.path(), &mut warnings, load).name, "alpha");
        assert_eq!(cached(b.path(), &mut warnings, load).name, "beta");
        assert_eq!(cached(a.path(), &mut warnings, load).name, "alpha");
    }

    #[test]
    fn a_project_without_config_yaml_is_resolved_once_and_again_when_one_appears() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("openspec")).unwrap();
        let calls = AtomicUsize::new(0);
        let load = |_: &Path, _: &mut Vec<String>| {
            calls.fetch_add(1, Ordering::SeqCst);
            SchemaInfo {
                name: DEFAULT_SCHEMA.into(),
                description: None,
                artifacts: default_artifacts(),
                assumed: true,
            }
        };

        let mut warnings = Vec::new();
        cached(dir.path(), &mut warnings, load);
        cached(dir.path(), &mut warnings, load);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        std::fs::write(
            dir.path().join("openspec").join("config.yaml"),
            "schema: spec-driven\n",
        )
        .unwrap();
        cached(dir.path(), &mut warnings, load);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "a config.yaml appearing must invalidate the cached answer"
        );
    }

    #[test]
    fn parses_artifact_order_and_requires_from_yaml() {
        let yaml = r#"
name: spec-driven
version: 1
description: Default OpenSpec workflow
artifacts:
  - id: proposal
    generates: proposal.md
    description: Initial proposal
    requires: []
  - id: specs
    generates: "specs/**/*.md"
    requires: [proposal]
  - id: design
    generates: design.md
    requires: [proposal]
  - id: tasks
    generates: tasks.md
    requires: [specs, design]
"#;
        let info = parse_schema_yaml(yaml, "fallback").unwrap();
        assert_eq!(info.name, "spec-driven");
        assert!(!info.assumed);
        let ids: Vec<_> = info.artifacts.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["proposal", "specs", "design", "tasks"]);
        assert_eq!(info.artifacts[1].generates, "specs/**/*.md");
        assert_eq!(info.artifacts[3].requires, vec!["specs", "design"]);
    }

    #[test]
    fn honours_a_non_default_schema_order() {
        // A project may declare any order; we must not reimpose spec-driven.
        let yaml = r#"
name: docs-first
artifacts:
  - id: design
  - id: proposal
  - id: tasks
"#;
        let info = parse_schema_yaml(yaml, "fallback").unwrap();
        let ids: Vec<_> = info.artifacts.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["design", "proposal", "tasks"]);
        // Missing `generates` falls back to `<id>.md`.
        assert_eq!(info.artifacts[0].generates, "design.md");
    }

    #[test]
    fn rejects_a_schema_with_no_artifacts() {
        assert!(parse_schema_yaml("name: empty\nartifacts: []\n", "x").is_err());
    }

    #[test]
    fn reads_declared_schema_name_from_config() {
        let dir = tempfile::tempdir().unwrap();
        let os = dir.path().join("openspec");
        std::fs::create_dir_all(&os).unwrap();
        std::fs::write(os.join("config.yaml"), "schema: custom-flow\n").unwrap();
        assert_eq!(schema_name(dir.path()), "custom-flow");
    }

    #[test]
    fn reads_the_project_context_out_of_the_config() {
        let dir = tempfile::tempdir().unwrap();
        let os = dir.path().join("openspec");
        std::fs::create_dir_all(&os).unwrap();
        std::fs::write(
            os.join("config.yaml"),
            "schema: spec-driven\n\ncontext: |\n  Tech stack: Rust, TypeScript\n  We use conventional commits\n",
        )
        .unwrap();

        let context = project_context(dir.path()).unwrap();
        assert!(context.starts_with("Tech stack: Rust, TypeScript"));
        assert!(context.contains("conventional commits"));
        assert!(!context.ends_with('\n'), "trimmed");
    }

    #[test]
    fn has_no_context_when_the_config_does_not_set_one() {
        let dir = tempfile::tempdir().unwrap();
        let os = dir.path().join("openspec");
        std::fs::create_dir_all(&os).unwrap();
        // The scaffolded config comments the key out rather than setting it.
        std::fs::write(os.join("config.yaml"), "schema: spec-driven\n# context: |\n#   ...\n").unwrap();
        assert_eq!(project_context(dir.path()), None);

        std::fs::write(os.join("config.yaml"), "schema: x\ncontext: \"   \"\n").unwrap();
        assert_eq!(project_context(dir.path()), None, "blank is no context");
    }

    #[test]
    fn defaults_schema_name_when_config_is_absent_or_silent() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(schema_name(dir.path()), DEFAULT_SCHEMA);

        let os = dir.path().join("openspec");
        std::fs::create_dir_all(&os).unwrap();
        std::fs::write(os.join("config.yaml"), "# only comments here\n").unwrap();
        assert_eq!(schema_name(dir.path()), DEFAULT_SCHEMA);
    }

    #[test]
    fn derives_packaged_schema_path_from_a_template_path() {
        let dir = tempfile::tempdir().unwrap();
        let schema_dir = dir.path().join("schemas").join("spec-driven");
        std::fs::create_dir_all(schema_dir.join("templates")).unwrap();
        std::fs::write(schema_dir.join("schema.yaml"), "name: spec-driven\n").unwrap();
        let template = schema_dir.join("templates").join("proposal.md");
        std::fs::write(&template, "# t").unwrap();

        let found = packaged_schema_path(template.to_str().unwrap()).unwrap();
        assert_eq!(found, schema_dir.join("schema.yaml"));
    }

    #[test]
    fn packaged_schema_path_is_none_when_definition_is_missing() {
        assert!(packaged_schema_path("/nope/schemas/x/templates/proposal.md").is_none());
    }
}
