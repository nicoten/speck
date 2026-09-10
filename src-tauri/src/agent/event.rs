//! Turning Claude Code's `stream-json` output into what the panel shows.
//!
//! The CLI emits a lot per turn — hooks, thinking-token counts, rate-limit
//! notices, partial frames. A reader wants to know what the agent is *doing*:
//! which file it touched, which command it ran, what it said, and how it ended.
//! Everything else is dropped here rather than in the UI.
//!
//! Mapping is a pure function over one line so it can be tested against a
//! stream captured from the real CLI (`tests/fixtures/stream.jsonl`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AgentEvent {
    /// The session exists and has told us how it is configured.
    Started {
        session_id: String,
        model: Option<String>,
        permission_mode: Option<String>,
    },
    /// Something the agent said.
    Message { text: String },
    /// A tool call, with the one detail worth reading: the file, the command,
    /// the pattern.
    Tool {
        name: String,
        detail: Option<String>,
    },
    /// A tool call came back. `ok` is false when the tool reported an error.
    ToolDone { ok: bool },
    /// The run ended.
    Finished {
        ok: bool,
        turns: Option<u32>,
        duration_ms: Option<u64>,
        cost_usd: Option<f64>,
        /// Tools the agent asked for and was refused. Surfaced rather than
        /// swallowed: a denied Bash call is usually why an apply stalled.
        denials: Vec<String>,
        error: Option<String>,
    },
    /// The process itself failed, outside the protocol.
    Failed { message: String },
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

/// The detail worth showing for a tool call, shortened for one line.
fn tool_detail(name: &str, input: &Value, root: &Path) -> Option<String> {
    let relative = |p: &str| {
        Path::new(p)
            .strip_prefix(root)
            .map(|r| r.to_string_lossy().to_string())
            .unwrap_or_else(|_| p.to_string())
    };

    let raw = match name {
        "Read" | "Edit" | "Write" | "NotebookEdit" => {
            string_at(input, "file_path").map(|p| relative(&p))
        }
        "Bash" => string_at(input, "command"),
        "Glob" | "Grep" => string_at(input, "pattern"),
        "Task" => string_at(input, "description"),
        "TodoWrite" => Some("updating the task list".to_string()),
        _ => None,
    }?;

    let raw = raw.replace('\n', " ");
    Some(if raw.chars().count() > 120 {
        let cut: String = raw.chars().take(119).collect();
        format!("{cut}…")
    } else {
        raw
    })
}

/// Map one line of `stream-json`. `None` means "nothing a reader needs".
pub fn parse_line(line: &str, root: &Path) -> Option<AgentEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;

    match value.get("type")?.as_str()? {
        "system" if value.get("subtype").and_then(Value::as_str) == Some("init") => {
            Some(AgentEvent::Started {
                session_id: string_at(&value, "session_id").unwrap_or_default(),
                model: string_at(&value, "model"),
                permission_mode: string_at(&value, "permissionMode"),
            })
        }

        "assistant" => {
            // One line can carry several blocks; the first that says something
            // is what the log shows.
            let content = value.get("message")?.get("content")?.as_array()?;
            content.iter().find_map(|block| {
                match block.get("type")?.as_str()? {
                    "text" => {
                        let text = string_at(block, "text")?;
                        (!text.trim().is_empty()).then_some(AgentEvent::Message { text })
                    }
                    "tool_use" => {
                        let name = string_at(block, "name")?;
                        let detail = block
                            .get("input")
                            .and_then(|input| tool_detail(&name, input, root));
                        Some(AgentEvent::Tool { name, detail })
                    }
                    // Thinking is the agent's private reasoning; not shown.
                    _ => None,
                }
            })
        }

        "user" => {
            let content = value.get("message")?.get("content")?.as_array()?;
            content.iter().find_map(|block| {
                if block.get("type")?.as_str()? != "tool_result" {
                    return None;
                }
                let ok = !block
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                Some(AgentEvent::ToolDone { ok })
            })
        }

        "result" => {
            let is_error = value
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let subtype = value.get("subtype").and_then(Value::as_str);
            let denials = value
                .get("permission_denials")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|d| string_at(d, "tool_name"))
                        .collect()
                })
                .unwrap_or_default();

            Some(AgentEvent::Finished {
                ok: !is_error && subtype != Some("error_during_execution"),
                turns: value
                    .get("num_turns")
                    .and_then(Value::as_u64)
                    .map(|n| n as u32),
                duration_ms: value.get("duration_ms").and_then(Value::as_u64),
                cost_usd: value.get("total_cost_usd").and_then(Value::as_f64),
                denials,
                error: if is_error {
                    string_at(&value, "result").or_else(|| subtype.map(str::to_string))
                } else {
                    None
                },
            })
        }

        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// The fixture's paths are normalised to this root.
    fn root() -> PathBuf {
        PathBuf::from("/proj")
    }

    /// Every event kind the real CLI emitted, mapped.
    fn fixture_events() -> Vec<AgentEvent> {
        let raw = include_str!("../../tests/fixtures/stream.jsonl");
        raw.lines().filter_map(|l| parse_line(l, &root())).collect()
    }

    #[test]
    fn maps_a_real_captured_stream_to_the_events_a_reader_needs() {
        let events = fixture_events();

        assert!(
            matches!(events.first(), Some(AgentEvent::Started { .. })),
            "first useful event is the session starting, got {:?}",
            events.first()
        );
        assert!(
            matches!(events.last(), Some(AgentEvent::Finished { ok: true, .. })),
            "last is the result, got {:?}",
            events.last()
        );
        // The Read is reported by name, with its path relative to the project.
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::Tool { name, detail }
                if name == "Read" && detail.as_deref() == Some("note.txt")
        )), "expected a relative Read, got {events:#?}");
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::Message { text } if text == "hello from speck")));
    }

    #[test]
    fn drops_hook_thinking_and_rate_limit_noise() {
        let noise = [
            r#"{"type":"system","subtype":"hook_started","hook_name":"x"}"#,
            r#"{"type":"system","subtype":"thinking_tokens","estimated_tokens":10}"#,
            r#"{"type":"rate_limit_event","rate_limit_info":{}}"#,
            r#"{"type":"stream_event","event":{}}"#,
            "",
            "not json at all",
        ];
        for line in noise {
            assert_eq!(parse_line(line, &root()), None, "should drop: {line}");
        }
    }

    #[test]
    fn never_shows_the_agents_private_reasoning() {
        let line = r#"{"type":"assistant","message":{"content":[
            {"type":"thinking","thinking":"the user probably wants..."}]}}"#;
        assert_eq!(parse_line(line, &root()), None);
    }

    #[test]
    fn reports_paths_relative_to_the_project() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use",
            "name":"Edit","input":{"file_path":"/proj/src/App.tsx"}}]}}"#;
        assert_eq!(
            parse_line(line, Path::new("/proj")),
            Some(AgentEvent::Tool {
                name: "Edit".into(),
                detail: Some("src/App.tsx".into()),
            })
        );
    }

    #[test]
    fn shows_the_command_for_a_bash_call_and_shortens_a_long_one() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use",
            "name":"Bash","input":{"command":"openspec status --change c --json"}}]}}"#;
        assert_eq!(
            parse_line(line, &root()),
            Some(AgentEvent::Tool {
                name: "Bash".into(),
                detail: Some("openspec status --change c --json".into()),
            })
        );

        let long = "x".repeat(400);
        let line = format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use",
            "name":"Bash","input":{{"command":"{long}"}}}}]}}}}"#
        );
        let Some(AgentEvent::Tool { detail, .. }) = parse_line(&line, &root()) else {
            panic!("expected a tool event");
        };
        assert_eq!(detail.unwrap().chars().count(), 120);
    }

    #[test]
    fn surfaces_permission_denials_rather_than_swallowing_them() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,
            "num_turns":4,"duration_ms":9000,"total_cost_usd":0.12,
            "permission_denials":[{"tool_name":"Bash"},{"tool_name":"WebFetch"}]}"#;
        let Some(AgentEvent::Finished { denials, ok, turns, cost_usd, .. }) =
            parse_line(line, &root())
        else {
            panic!("expected finished");
        };
        assert!(ok);
        assert_eq!(turns, Some(4));
        assert_eq!(cost_usd, Some(0.12));
        assert_eq!(denials, vec!["Bash", "WebFetch"]);
    }

    #[test]
    fn reports_a_failed_run_as_not_ok_with_its_reason() {
        let line = r#"{"type":"result","subtype":"error_during_execution",
            "is_error":true,"result":"something went wrong"}"#;
        let Some(AgentEvent::Finished { ok, error, .. }) = parse_line(line, &root()) else {
            panic!("expected finished");
        };
        assert!(!ok);
        assert_eq!(error.as_deref(), Some("something went wrong"));
    }

    #[test]
    fn marks_a_tool_result_that_reported_an_error() {
        let line = r#"{"type":"user","message":{"content":[{"type":"tool_result",
            "tool_use_id":"t1","is_error":true,"content":"no such file"}]}}"#;
        assert_eq!(parse_line(line, &root()), Some(AgentEvent::ToolDone { ok: false }));
    }
}
