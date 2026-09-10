//! Handing work to a Claude session in the user's terminal.
//!
//! Speck does not do the work and does not write to your project. OpenSpec's
//! apply and propose are agent workflows — the CLI produces a brief, an agent
//! carries it out — so this writes a short script to the OS temp directory and
//! asks the system to open it. The session then runs where you can see it and
//! approve what it does, which is why this is a handoff rather than something
//! Speck drives itself.
//!
//! The webview asks for an [`AgentAction`], never a command line: it can name a
//! change or describe an idea, and nothing else.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum AgentAction {
    /// Implement a change's tasks: `/opsx:apply <change>`.
    Apply { change: String },
    /// Plan a new change: `/opsx:propose <idea>`. Planning only — the OpenSpec
    /// workflow forbids touching project code in this step.
    Propose { idea: String },
    /// Check the implementation against the change's specs: `/opsx:verify`.
    /// Reads and reports; it is not meant to change code.
    Verify { change: String },
    /// Fold the delta specs into the main specs and archive the change:
    /// `/opsx:archive`. The workflow asks how to merge before it does, which is
    /// why it wants somewhere to ask.
    Archive { change: String },
}

impl AgentAction {
    /// What the session will be asked to do.
    pub fn prompt(&self) -> Result<String> {
        match self {
            AgentAction::Apply { change } => {
                let change = validate_change_name(change)?;
                Ok(format!("/opsx:apply {change}"))
            }
            AgentAction::Verify { change } => {
                let change = validate_change_name(change)?;
                Ok(format!("/opsx:verify {change}"))
            }
            AgentAction::Archive { change } => {
                let change = validate_change_name(change)?;
                Ok(format!("/opsx:archive {change}"))
            }
            AgentAction::Propose { idea } => {
                let idea = idea.trim();
                if idea.is_empty() {
                    return Err(anyhow!("Describe the change before starting a session"));
                }
                if idea.chars().count() > 4000 {
                    return Err(anyhow!("That description is too long"));
                }
                Ok(format!("/opsx:propose {idea}"))
            }
        }
    }

    /// Short slug for the script's file name, so a stray temp file is obvious.
    fn slug(&self) -> &'static str {
        match self {
            AgentAction::Apply { .. } => "apply",
            AgentAction::Verify { .. } => "verify",
            AgentAction::Archive { .. } => "archive",
            AgentAction::Propose { .. } => "propose",
        }
    }
}

/// Change names come from the tree, but validate anyway: this one ends up in a
/// command line, and a name is a directory name, never a path or a flag.
fn validate_change_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() {
        return Err(anyhow!("No change selected"));
    }
    let ok = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !ok || name.starts_with('-') || name.contains("..") {
        return Err(anyhow!("'{name}' is not a valid change name"));
    }
    Ok(name)
}

/// Quote a string for safe inclusion in a single-quoted shell word.
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// The script that gets opened. The prompt is passed through a file rather than
/// interpolated into the command line, so nothing in it can be read as shell.
fn script_body(root: &Path, prompt_file: &Path) -> String {
    format!(
        r#"#!/bin/bash
# Written by Speck. Runs an OpenSpec workflow in this project with Claude Code.
# Close this window when the session is finished.
cd {root} || exit 1
prompt=$(cat {prompt_file}) || exit 1
rm -f {prompt_file}
if ! command -v claude >/dev/null 2>&1; then
  echo "Speck could not find the 'claude' command on your PATH."
  echo "Install Claude Code, then run:  claude \"$prompt\""
  exec "$SHELL" -il
fi
exec claude "$prompt"
"#,
        root = shell_single_quote(&root.to_string_lossy()),
        prompt_file = shell_single_quote(&prompt_file.to_string_lossy()),
    )
}

fn unique_name(slug: &str, ext: &str) -> String {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("speck-{slug}-{stamp}.{ext}")
}

/// A handoff written to disk and ready to open.
pub struct Handoff {
    pub script: PathBuf,
    pub prompt: String,
}

/// Write the handoff script, without opening anything.
///
/// Split from [`start`] so the interesting half — what the script does — can be
/// tested by running it against a stub, rather than by opening a terminal and
/// letting a real session loose on a real repository.
fn prepare(root: &Path, action: &AgentAction, dir: &Path) -> Result<Handoff> {
    let prompt = action.prompt()?;
    let prompt_file = dir.join(unique_name(action.slug(), "txt"));
    let script = dir.join(unique_name(action.slug(), "command"));

    std::fs::write(&prompt_file, &prompt)
        .with_context(|| format!("writing {}", prompt_file.display()))?;
    std::fs::write(&script, script_body(root, &prompt_file))
        .with_context(|| format!("writing {}", script.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
    }

    Ok(Handoff { script, prompt })
}

/// Write the handoff script and open it, returning the prompt that was handed
/// over so the UI can say what it started.
pub fn start(root: &Path, action: &AgentAction) -> Result<String> {
    let handoff = prepare(root, action, &std::env::temp_dir())?;

    // `.command` scripts open in whichever terminal the user has as the handler.
    let status = Command::new("open")
        .arg(&handoff.script)
        .status()
        .context("asking the system to open a terminal")?;

    if !status.success() {
        return Err(anyhow!("could not open a terminal window"));
    }
    Ok(handoff.prompt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_apply_command_for_a_change() {
        let action = AgentAction::Apply {
            change: "report-toolbar".into(),
        };
        assert_eq!(action.prompt().unwrap(), "/opsx:apply report-toolbar");
    }

    #[test]
    fn builds_the_propose_command_from_an_idea() {
        let action = AgentAction::Propose {
            idea: "  add a CSV export to the report toolbar  ".into(),
        };
        assert_eq!(
            action.prompt().unwrap(),
            "/opsx:propose add a CSV export to the report toolbar"
        );
    }

    #[test]
    fn builds_the_verify_and_archive_commands() {
        assert_eq!(
            AgentAction::Verify {
                change: "report-toolbar".into()
            }
            .prompt()
            .unwrap(),
            "/opsx:verify report-toolbar"
        );
        assert_eq!(
            AgentAction::Archive {
                change: "report-toolbar".into()
            }
            .prompt()
            .unwrap(),
            "/opsx:archive report-toolbar"
        );
    }

    #[test]
    fn validates_the_change_name_for_every_action_that_takes_one() {
        // The name reaches a command line whichever workflow uses it.
        for action in [
            AgentAction::Apply { change: "a; rm -rf /".into() },
            AgentAction::Verify { change: "../escape".into() },
            AgentAction::Archive { change: "--dangerously-skip-permissions".into() },
        ] {
            assert!(action.prompt().is_err(), "should reject {action:?}");
        }
    }

    #[test]
    fn refuses_a_change_name_that_is_not_one() {
        for bad in [
            "a; rm -rf /",
            "../escape",
            "--dangerously-skip-permissions",
            "with space",
            "back`tick`",
            "",
            "   ",
        ] {
            let action = AgentAction::Apply { change: bad.into() };
            assert!(action.prompt().is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn refuses_an_empty_idea() {
        assert!(AgentAction::Propose { idea: "   ".into() }.prompt().is_err());
    }

    #[test]
    fn quotes_paths_containing_quotes_and_spaces() {
        assert_eq!(shell_single_quote("/tmp/a b"), "'/tmp/a b'");
        assert_eq!(shell_single_quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn the_script_never_interpolates_the_prompt() {
        // The prompt reaches the session through a file, so an idea containing
        // shell syntax cannot become shell.
        let body = script_body(Path::new("/tmp/proj"), Path::new("/tmp/p.txt"));
        assert!(body.contains("prompt=$(cat '/tmp/p.txt')"));
        assert!(body.contains("cd '/tmp/proj'"));
        assert!(body.contains(r#"exec claude "$prompt""#));
    }

    struct StubRun {
        prompt: String,
        cwd: String,
        dir: tempfile::TempDir,
    }

    /// Run a prepared script with a stub `claude` on PATH, and report what that
    /// stub was asked to do. Proves the whole handoff without starting a real
    /// session against a real repository.
    ///
    /// `SHELL` is pointed at a command that exits: when `claude` is missing the
    /// script hands the user an interactive shell, which would hang a test
    /// forever.
    fn run_with_stub_claude(action: &AgentAction, project: &Path) -> StubRun {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();

        let record = tmp.path().join("record.txt");
        let stub = bin.join("claude");
        std::fs::write(
            &stub,
            format!(
                "#!/bin/bash\nprintf '%s' \"$1\" > '{}'\npwd > '{}'\n",
                record.display(),
                tmp.path().join("cwd.txt").display()
            ),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o700)).unwrap();
        }

        let handoff = prepare(project, action, tmp.path()).unwrap();
        let status = Command::new("bash")
            .arg(&handoff.script)
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env("SHELL", "/usr/bin/true")
            .status()
            .unwrap();
        assert!(status.success(), "handoff script failed");

        let prompt = std::fs::read_to_string(&record).unwrap();
        let cwd = std::fs::read_to_string(tmp.path().join("cwd.txt")).unwrap();
        StubRun { prompt, cwd, dir: tmp }
    }

    #[test]
    fn hands_the_apply_command_to_claude_in_the_project_directory() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let run = run_with_stub_claude(
            &AgentAction::Apply {
                change: "report-toolbar".into(),
            },
            &root,
        );
        assert_eq!(run.prompt, "/opsx:apply report-toolbar");
        assert_eq!(run.cwd.trim(), root.to_string_lossy());
    }

    #[test]
    fn passes_an_idea_through_verbatim_even_with_shell_syntax_in_it() {
        // The idea reaches the session as one argument, not as shell.
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let idea = "add $(whoami) support; drop `old` tables && \"quote\" it";
        let run = run_with_stub_claude(&AgentAction::Propose { idea: idea.into() }, &root);
        assert_eq!(run.prompt, format!("/opsx:propose {idea}"));
    }

    #[test]
    fn removes_the_prompt_file_once_it_is_read() {
        let project = tempfile::tempdir().unwrap();
        let run = run_with_stub_claude(
            &AgentAction::Apply { change: "c".into() },
            project.path(),
        );
        let leftover = std::fs::read_dir(run.dir.path())
            .unwrap()
            .flatten()
            .filter(|e| {
                e.path()
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("speck-"))
                    && e.path().extension().is_some_and(|x| x == "txt")
            })
            .count();
        assert_eq!(leftover, 0, "prompt file left behind");
    }

    #[test]
    fn the_script_explains_itself_when_claude_is_missing() {
        let body = script_body(Path::new("/p"), Path::new("/p.txt"));
        assert!(body.contains("command -v claude"));
        assert!(body.contains("Install Claude Code"));
    }
}
