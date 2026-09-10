//! Talking to the `openspec` binary.
//!
//! The CLI is the authority on ordering and status, so this is the primary
//! source. Everything here is read-only: no subcommand invoked below mutates
//! the project.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

/// How to invoke a tool: the binary, plus the `PATH` its child process needs.
/// Resolved once per tool.
static OPENSPEC: OnceLock<Option<Resolved>> = OnceLock::new();
static GH: OnceLock<Option<Resolved>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct Resolved {
    bin: PathBuf,
    /// `PATH` to hand the child process, when the inherited one is not enough.
    path_env: Option<String>,
}

impl Resolved {
    /// A command for this tool, carrying the `PATH` it needs.
    pub fn command(&self) -> Command {
        let mut cmd = Command::new(&self.bin);
        if let Some(path) = &self.path_env {
            cmd.env("PATH", path);
        }
        cmd
    }

    pub fn path(&self) -> &Path {
        &self.bin
    }
}

/// Markers so the shell probe's output can be parsed even when an interactive
/// rc file prints banners of its own.
const PATH_MARKER: &str = "__speck_path__";
const BIN_MARKER: &str = "__speck_bin__";

/// How long to wait for the user's shell to start. An rc file that blocks must
/// not hang the app at launch.
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

/// Locate `openspec`.
///
/// A macOS app launched from Finder or Spotlight inherits a minimal `PATH`, so
/// version-manager installs are invisible to a plain `Command::new("openspec")`.
/// Two things make that harder than it looks:
///
///   * asdf, pyenv, rbenv and friends are usually configured in `.zshrc`, which
///     a *non-interactive* login shell does not read — so the probe shell has to
///     be interactive (`-ilc`), not just a login shell (`-lc`).
///   * a shim is typically `exec asdf …`, so it only works if `asdf` itself is on
///     `PATH`. Knowing the shim's path is not enough; the child process needs the
///     shell's whole `PATH`.
///
/// So we ask the shell for both the binary and its `PATH`, and carry that `PATH`
/// into every call.
pub fn resolved() -> Option<&'static Resolved> {
    OPENSPEC.get_or_init(|| resolve("openspec")).as_ref()
}

/// The `gh` binary, for asking GitHub about a change's pull request.
pub fn gh() -> Option<&'static Resolved> {
    GH.get_or_init(|| resolve("gh")).as_ref()
}

/// Locate a tool the same way for every tool: PATH as inherited, then the
/// user's interactive login shell, then the usual install locations.
fn resolve(name: &str) -> Option<Resolved> {
    // Already on PATH (the usual case when launched from a terminal).
    let inherited = Resolved {
        bin: PathBuf::from(name),
        path_env: None,
    };
    if probe(&inherited) {
        return Some(inherited);
    }

    // Ask the user's shell where it is, and what PATH it uses.
    let (shell_path, shell_bin) = shell_probe(name);

    if let Some(bin) = shell_bin {
        let candidate = Resolved {
            bin,
            path_env: shell_path.clone(),
        };
        if probe(&candidate) {
            return Some(candidate);
        }
    }

    // Last resort: the usual install locations, tried with the shell's PATH
    // when we managed to read it.
    well_known_paths(name).into_iter().find_map(|bin| {
        let candidate = Resolved {
            bin,
            path_env: shell_path.clone(),
        };
        probe(&candidate).then_some(candidate)
    })
}

/// The resolved binary path, for display.
pub fn binary() -> Option<&'static PathBuf> {
    resolved().map(|r| &r.bin)
}

/// Does this candidate answer `--version`?
fn probe(r: &Resolved) -> bool {
    r.command()
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Pull the marked values out of the probe shell's output, ignoring anything
/// else an rc file decided to print.
fn parse_shell_probe(stdout: &str) -> (Option<String>, Option<PathBuf>) {
    let mut path = None;
    let mut bin = None;
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(PATH_MARKER) {
            if !rest.is_empty() {
                path = Some(rest.to_string());
            }
        } else if let Some(rest) = line.strip_prefix(BIN_MARKER) {
            if !rest.is_empty() {
                bin = Some(PathBuf::from(rest));
            }
        }
    }
    (path, bin)
}

/// Ask the user's login shell, interactively, for its `PATH` and the location
/// of `openspec`.
fn shell_probe(name: &str) -> (Option<String>, Option<PathBuf>) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let script = format!(
        "printf '{PATH_MARKER}%s\\n{BIN_MARKER}%s\\n' \"$PATH\" \"$(command -v {name} 2>/dev/null)\""
    );

    // An interactive shell runs the user's rc files, which could block; do not
    // let that hang startup.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = Command::new(shell)
            .args(["-ilc", &script])
            // TERM=dumb keeps prompt and banner noise down.
            .env("TERM", "dumb")
            .output();
        let _ = tx.send(out);
    });

    match rx.recv_timeout(SHELL_TIMEOUT) {
        Ok(Ok(out)) => parse_shell_probe(&String::from_utf8_lossy(&out.stdout)),
        _ => (None, None),
    }
}

fn well_known_paths(name: &str) -> Vec<PathBuf> {
    let mut out = vec![
        PathBuf::from(format!("/opt/homebrew/bin/{name}")),
        PathBuf::from(format!("/usr/local/bin/{name}")),
    ];
    if let Some(home) = dirs_home() {
        for dir in [".asdf/shims", ".local/bin", ".bun/bin", ".volta/bin"] {
            out.push(home.join(dir).join(name));
        }
    }
    out
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Run `openspec <args>` with the working directory set to `cwd` and parse
/// stdout as JSON.
///
/// `cwd` is how the project is selected: the CLI resolves the nearest OpenSpec
/// root from there, which is exactly the behaviour we want per project.
pub fn json<T: for<'de> Deserialize<'de>>(cwd: &Path, args: &[&str]) -> Result<T> {
    let r = resolved().ok_or_else(|| anyhow!("openspec CLI not found"))?;
    let out = r
        .command()
        .args(args)
        .arg("--no-color")
        .current_dir(cwd)
        .output()
        .with_context(|| format!("running openspec {}", args.join(" ")))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!(
            "openspec {} failed: {}",
            args.join(" "),
            stderr.trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    // Some subcommands print progress lines before the JSON payload, so start
    // parsing at the first structural character rather than at byte zero.
    let start = stdout
        .find(['{', '['])
        .ok_or_else(|| anyhow!("openspec {} returned no JSON", args.join(" ")))?;
    serde_json::from_str(&stdout[start..])
        .with_context(|| format!("parsing JSON from openspec {}", args.join(" ")))
}

pub fn version() -> Option<String> {
    let out = resolved()?.command().arg("--version").output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ---------------------------------------------------------------------------
// Wire types.
//
// Every field is optional or defaulted: the CLI's JSON shape may grow across
// versions, and a new or renamed field should degrade one value rather than
// fail the whole read.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ListChanges {
    pub changes: Vec<ListChange>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ListChange {
    pub name: String,
    pub completed_tasks: Option<u32>,
    pub total_tasks: Option<u32>,
    pub last_modified: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ListSpecs {
    pub specs: Vec<ListSpec>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ListSpec {
    pub id: String,
    pub requirement_count: Option<u32>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct StatusReport {
    pub changes: Vec<StatusChange>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct StatusChange {
    pub change_name: String,
    pub schema_name: Option<String>,
    pub change_root: Option<String>,
    /// Ordered by schema. This ordering is the whole point of the call.
    pub artifacts: Vec<StatusArtifact>,
    pub artifact_paths: HashMap<String, ArtifactPaths>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct StatusArtifact {
    pub id: String,
    pub output_path: String,
    pub status: Option<String>,
    pub requires: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ArtifactPaths {
    pub existing_output_paths: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SchemaSummary {
    pub name: String,
    pub description: Option<String>,
    pub artifacts: Vec<String>,
    pub source: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct StoreList {
    pub stores: Vec<StoreEntry>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct StoreEntry {
    pub id: String,
    pub path: Option<String>,
}

pub fn list_changes(cwd: &Path) -> Result<ListChanges> {
    json(cwd, &["list", "--changes", "--json"])
}

pub fn list_specs(cwd: &Path) -> Result<ListSpecs> {
    json(cwd, &["list", "--specs", "--json"])
}

pub fn status_all(cwd: &Path) -> Result<StatusReport> {
    json(cwd, &["status", "--all", "--json"])
}

pub fn schemas(cwd: &Path) -> Result<Vec<SchemaSummary>> {
    json(cwd, &["schemas", "--json"])
}

/// Resolved template paths for a schema, keyed by artifact id. Used to locate
/// the schema definition that shipped with the CLI package.
pub fn templates(cwd: &Path, schema: &str) -> Result<HashMap<String, String>> {
    json(cwd, &["templates", "--schema", schema, "--json"])
}

pub fn stores() -> Result<StoreList> {
    let home = dirs_home().unwrap_or_else(|| PathBuf::from("/"));
    json(&home, &["store", "list", "--json"])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_marked_values_past_shell_banner_noise() {
        let stdout = format!(
            "Welcome to your shell!\n{PATH_MARKER}/a/bin:/b/bin\n{BIN_MARKER}/home/me/.asdf/shims/openspec\nlast login: today\n"
        );
        let (path, bin) = parse_shell_probe(&stdout);
        assert_eq!(path.as_deref(), Some("/a/bin:/b/bin"));
        assert_eq!(bin, Some(PathBuf::from("/home/me/.asdf/shims/openspec")));
    }

    #[test]
    fn treats_an_empty_marker_value_as_not_found() {
        // `command -v openspec` prints nothing when the binary is absent.
        let stdout = format!("{PATH_MARKER}/usr/bin\n{BIN_MARKER}\n");
        let (path, bin) = parse_shell_probe(&stdout);
        assert_eq!(path.as_deref(), Some("/usr/bin"));
        assert_eq!(bin, None);
    }

    #[test]
    fn returns_nothing_when_the_shell_printed_no_markers() {
        assert_eq!(parse_shell_probe("some unrelated output\n"), (None, None));
    }

    /// The real environment: whatever this machine has, resolution must agree
    /// with itself — if a binary is found, it must answer `--version`.
    #[test]
    fn resolution_is_self_consistent() {
        match resolved() {
            Some(r) => assert!(probe(r), "resolved a binary that does not run"),
            None => eprintln!("openspec not installed here; nothing to check"),
        }
    }
}
