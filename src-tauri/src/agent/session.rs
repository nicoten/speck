//! Running a Claude session inside Speck, and reporting what it does.
//!
//! This is the half that changes what Speck is: it starts an agent with
//! authority to edit the project. The mode is chosen by the person pressing the
//! button, passed through, and reported back in the first event, so the panel
//! can state the authority the run actually has rather than what it assumed.
//!
//! One session per project at a time. Two agents editing the same repository
//! would fight, and the second would be working from a tree the first is
//! changing underneath it.

use super::event::{parse_line, AgentEvent};
use super::AgentAction;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub const EVENT: &str = "agent://event";

/// How much authority the run is given.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Authority {
    /// File edits go through without asking; anything else is refused, and the
    /// refusals are reported when the run ends.
    Edits,
    /// Nothing is asked and nothing refused, including shell commands. Needed
    /// for a change whose tasks run tests.
    EditsAndCommands,
}

impl Authority {
    fn permission_mode(self) -> &'static str {
        match self {
            Authority::Edits => "acceptEdits",
            Authority::EditsAndCommands => "bypassPermissions",
        }
    }
}

/// What the UI needs to describe a run in flight.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningSession {
    pub id: String,
    pub root: String,
    pub label: String,
    pub authority: Authority,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    id: String,
    root: String,
    seq: u64,
    #[serde(flatten)]
    event: AgentEvent,
}

struct Run {
    child: Child,
    meta: RunningSession,
}

#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, Run>>);

impl Sessions {
    /// Runs in flight, so the UI can rebuild its state after a reload.
    pub fn running(&self) -> Vec<RunningSession> {
        self.0
            .lock()
            .unwrap()
            .values()
            .map(|r| r.meta.clone())
            .collect()
    }

    fn has_root(&self, root: &Path) -> bool {
        let root = root.to_string_lossy();
        self.0.lock().unwrap().values().any(|r| r.meta.root == root)
    }

    /// Stop a run. Killing the process is the only lever: the CLI owns the
    /// session, and a half-finished apply is why the panel says so plainly.
    pub fn stop(&self, id: &str) -> Result<()> {
        let mut runs = self.0.lock().unwrap();
        let run = runs
            .get_mut(id)
            .ok_or_else(|| anyhow!("that session is no longer running"))?;
        run.child.kill().context("stopping the session")?;
        Ok(())
    }

    fn remove(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
}

fn session_id() -> String {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("s{stamp}")
}

/// Start a session and stream its events to the front end.
pub fn start(
    app: AppHandle,
    sessions: Arc<Sessions>,
    root: &Path,
    action: &AgentAction,
    authority: Authority,
) -> Result<RunningSession> {
    if sessions.has_root(root) {
        return Err(anyhow!(
            "a session is already running for this project; stop it before starting another"
        ));
    }

    let prompt = action.prompt()?;
    let claude = crate::openspec::cli::claude().ok_or_else(|| {
        anyhow!("Speck could not find the 'claude' command. Install Claude Code.")
    })?;

    let mut child = claude
        .command()
        .arg("-p")
        .arg(&prompt)
        .args([
            "--output-format",
            "stream-json",
            // stream-json requires it, and it is what carries tool calls.
            "--verbose",
            "--permission-mode",
            authority.permission_mode(),
        ])
        .current_dir(root)
        // Without this the CLI waits three seconds for input that never comes.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("starting {}", claude.path().display()))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("could not read the session's output"))?;
    let stderr = child.stderr.take();

    let id = session_id();
    let meta = RunningSession {
        id: id.clone(),
        root: root.to_string_lossy().to_string(),
        label: action.label(),
        authority,
    };

    sessions
        .0
        .lock()
        .unwrap()
        .insert(id.clone(), Run { child, meta: meta.clone() });

    // Stderr is drained on its own thread: a full pipe would otherwise block
    // the child, and its last lines explain a start-up failure.
    let problems = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = stderr {
        let problems = Arc::clone(&problems);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut held = problems.lock().unwrap();
                if held.len() < 4000 {
                    held.push_str(&line);
                    held.push('\n');
                }
            }
        });
    }

    let root_owned = root.to_path_buf();
    std::thread::spawn(move || {
        let mut seq = 0u64;
        let mut emit = |event: AgentEvent| {
            seq += 1;
            let _ = app.emit(
                EVENT,
                Envelope {
                    id: id.clone(),
                    root: root_owned.to_string_lossy().to_string(),
                    seq,
                    event,
                },
            );
        };

        let saw_result = pump(BufReader::new(stdout), &root_owned, &mut emit);

        // The stream ended. Reap the child so a stop, a crash and a clean
        // finish are told apart rather than all looking like silence.
        let status = {
            let mut runs = sessions.0.lock().unwrap();
            runs.get_mut(&id).and_then(|r| r.child.wait().ok())
        };

        if !saw_result {
            let problems = problems.lock().unwrap().trim().to_string();
            let message = match status {
                Some(s) if s.code().is_none() => "The session was stopped.".to_string(),
                Some(s) if !s.success() && !problems.is_empty() => problems,
                Some(s) if !s.success() => format!("The session exited with status {s}."),
                _ => "The session ended without reporting a result.".to_string(),
            };
            emit(AgentEvent::Failed { message });
        }

        sessions.remove(&id);
    });

    Ok(meta)
}

/// Read a `stream-json` stream to its end, reporting each event worth showing.
///
/// Split out so the loop can be driven over canned lines: the alternative is
/// starting a real agent, and a test that edits a repository to prove the log
/// works is not a test worth having. Returns whether the run reported a result,
/// which is how a stop or a crash is told from a clean finish.
fn pump<R: BufRead>(
    reader: R,
    root: &Path,
    emit: &mut impl FnMut(AgentEvent),
) -> bool {
    let mut saw_result = false;
    for line in reader.lines().map_while(Result::ok) {
        if let Some(event) = parse_line(&line, root) {
            saw_result |= matches!(event, AgentEvent::Finished { .. });
            emit(event);
        }
    }
    saw_result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Drive the pump over lines and collect what it would have shown.
    fn pumped(lines: &str) -> (Vec<AgentEvent>, bool) {
        let mut events = Vec::new();
        let saw = pump(
            std::io::Cursor::new(lines.as_bytes()),
            Path::new("/proj"),
            &mut |e| events.push(e),
        );
        (events, saw)
    }

    #[test]
    fn streams_a_real_captured_session_in_order() {
        let (events, saw_result) = pumped(include_str!("../../tests/fixtures/stream.jsonl"));

        assert!(saw_result, "the run reported a result");
        assert!(matches!(events.first(), Some(AgentEvent::Started { .. })));
        assert!(matches!(
            events.last(),
            Some(AgentEvent::Finished { ok: true, .. })
        ));
        assert!(
            events.len() >= 4,
            "expected the session, its tool call, its reply and the result: {events:#?}"
        );
    }

    #[test]
    fn reports_no_result_when_the_stream_is_cut_off() {
        // What a stopped or crashed session looks like: events, then silence.
        let (events, saw_result) = pumped(
            r#"{"type":"system","subtype":"init","session_id":"s","model":"m"}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/proj/a.ts"}}]}}
"#,
        );
        assert!(!saw_result, "no result means the caller must explain why");
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn survives_a_garbled_line_without_losing_the_rest() {
        let (events, saw_result) = pumped(
            r#"{"type":"system","subtype":"init","session_id":"s"}
{ this is not json
{"type":"result","subtype":"success","is_error":false}
"#,
        );
        assert!(saw_result);
        assert_eq!(events.len(), 2, "the broken line is skipped, not fatal");
    }

    #[test]
    fn maps_authority_onto_the_cli_permission_modes() {
        assert_eq!(Authority::Edits.permission_mode(), "acceptEdits");
        assert_eq!(
            Authority::EditsAndCommands.permission_mode(),
            "bypassPermissions"
        );
    }

    #[test]
    fn refuses_a_second_session_for_the_same_project() {
        // Two agents editing one repository would work from trees they are each
        // changing underneath the other.
        let sessions = Sessions::default();
        sessions.0.lock().unwrap().insert(
            "s1".into(),
            Run {
                child: Command::new("/usr/bin/true").spawn().unwrap(),
                meta: RunningSession {
                    id: "s1".into(),
                    root: "/proj".into(),
                    label: "Applying add-auth".into(),
                    authority: Authority::Edits,
                },
            },
        );
        assert!(sessions.has_root(Path::new("/proj")));
        assert!(!sessions.has_root(Path::new("/other")));
    }

    #[test]
    fn stopping_an_unknown_session_says_so() {
        let sessions = Sessions::default();
        assert!(sessions.stop("nope").is_err());
    }

    #[test]
    fn reports_running_sessions_for_the_ui_to_restore() {
        let sessions = Sessions::default();
        assert!(sessions.running().is_empty());
        sessions.0.lock().unwrap().insert(
            "s1".into(),
            Run {
                child: Command::new("/usr/bin/true").spawn().unwrap(),
                meta: RunningSession {
                    id: "s1".into(),
                    root: "/proj".into(),
                    label: "Planning a change".into(),
                    authority: Authority::EditsAndCommands,
                },
            },
        );
        let running = sessions.running();
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].label, "Planning a change");
    }
}
