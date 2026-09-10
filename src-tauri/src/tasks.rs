//! Ticking a task off.
//!
//! This is the only thing Speck writes into a project, and it is deliberately
//! the smallest edit that can be made: one character on one line of one
//! `tasks.md`. Everything else in the file — indentation, bullet style, spacing,
//! line endings, the trailing newline — comes back byte for byte, because a
//! reader that reformats the file it is reading would be intolerable.
//!
//! Tasks are addressed by their text and, where the same text appears more than
//! once, by which occurrence. Not by line number: an agent may have rewritten
//! the file between it being read and the box being clicked, and a line number
//! would then tick the wrong task with no way to notice.

use anyhow::{anyhow, Context, Result};
use std::path::Path;

/// A checkbox found in the document.
#[derive(Debug, PartialEq)]
struct Checkbox {
    /// Index into the lines of the document.
    line: usize,
    /// Byte offset of the marker character within that line.
    marker_at: usize,
    done: bool,
    text: String,
}

/// Every `- [ ]` / `- [x]` line, in document order.
fn checkboxes(markdown: &str) -> Vec<Checkbox> {
    let mut found = Vec::new();

    for (line_no, line) in markdown.lines().enumerate() {
        let indent = line.len() - line.trim_start().len();
        let rest = &line[indent..];

        let Some(after_bullet) = rest
            .strip_prefix("- ")
            .or_else(|| rest.strip_prefix("* "))
        else {
            continue;
        };
        let bullet_len = rest.len() - after_bullet.len();

        let Some(after_open) = after_bullet.strip_prefix('[') else {
            continue;
        };
        let mut chars = after_open.chars();
        let Some(marker) = chars.next() else { continue };
        if chars.next() != Some(']') {
            continue;
        }
        let done = match marker {
            ' ' => false,
            'x' | 'X' => true,
            _ => continue,
        };

        let after_close = &after_open[marker.len_utf8() + 1..];
        found.push(Checkbox {
            line: line_no,
            marker_at: indent + bullet_len + 1,
            done,
            text: after_close.trim().to_string(),
        });
    }

    found
}

/// Set a task's state, returning the whole document.
///
/// `occurrence` counts from zero among the checkboxes whose text matches, so a
/// file listing the same wording twice can still be edited precisely.
pub fn toggle(markdown: &str, text: &str, occurrence: usize, done: bool) -> Result<String> {
    let boxes = checkboxes(markdown);
    let matches: Vec<&Checkbox> = boxes.iter().filter(|b| b.text == text).collect();

    let target = matches.get(occurrence).ok_or_else(|| {
        if matches.is_empty() {
            anyhow!("'{text}' is no longer in this file")
        } else {
            anyhow!(
                "'{text}' appears {} time(s) here, not {}",
                matches.len(),
                occurrence + 1
            )
        }
    })?;

    if target.done == done {
        // Already in the wanted state: leave the file alone rather than
        // rewriting it to the same bytes.
        return Ok(markdown.to_string());
    }

    let marker = if done { 'x' } else { ' ' };

    // Rebuilt from line-inclusive slices, so line endings and the presence or
    // absence of a trailing newline survive untouched.
    let mut out = String::with_capacity(markdown.len());
    for (i, line) in markdown.split_inclusive('\n').enumerate() {
        if i == target.line {
            out.push_str(&line[..target.marker_at]);
            out.push(marker);
            out.push_str(&line[target.marker_at + 1..]);
        } else {
            out.push_str(line);
        }
    }
    Ok(out)
}

/// Is this a file Speck is willing to write to?
///
/// Only a change's own `tasks.md`. The path has already been checked to sit
/// inside an open project; this narrows it to the one file whose one character
/// this app edits.
fn is_change_tasks_file(path: &Path) -> bool {
    let named_tasks = path.file_name().is_some_and(|n| n == "tasks.md");
    let under_changes = path
        .components()
        .collect::<Vec<_>>()
        .windows(2)
        .any(|w| w[0].as_os_str() == "openspec" && w[1].as_os_str() == "changes");
    named_tasks && under_changes
}

/// Tick a task off, or un-tick it.
pub fn set_done(path: &Path, text: &str, occurrence: usize, done: bool) -> Result<()> {
    if !is_change_tasks_file(path) {
        return Err(anyhow!(
            "Speck only edits a change's tasks.md, not {}",
            path.display()
        ));
    }

    let current = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;
    let updated = toggle(&current, text, occurrence, done)?;
    if updated == current {
        return Ok(());
    }

    // Write beside the file and rename over it: an interrupted write must not
    // leave someone's task list truncated.
    let temp = path.with_extension("md.speck-tmp");
    std::fs::write(&temp, &updated).with_context(|| format!("writing {}", temp.display()))?;
    std::fs::rename(&temp, path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "## 1. Schema\n\n- [x] 1.1 Add users table\n- [ ] 1.2 Add login endpoint\n\n## 2. Auth\n\n* [ ] 2.1 Hash passwords\n  - [ ] 2.1.1 Pick a cost factor\n";

    #[test]
    fn finds_every_checkbox_with_its_text_and_state() {
        let found = checkboxes(DOC);
        assert_eq!(
            found
                .iter()
                .map(|b| (b.text.as_str(), b.done))
                .collect::<Vec<_>>(),
            vec![
                ("1.1 Add users table", true),
                ("1.2 Add login endpoint", false),
                ("2.1 Hash passwords", false),
                ("2.1.1 Pick a cost factor", false),
            ]
        );
    }

    #[test]
    fn ticks_a_task_and_changes_nothing_else() {
        let out = toggle(DOC, "1.2 Add login endpoint", 0, true).unwrap();
        assert!(out.contains("- [x] 1.2 Add login endpoint"));
        // Every other line is identical, including the untouched checkboxes.
        assert_eq!(
            out.replace("- [x] 1.2", "- [ ] 1.2"),
            DOC,
            "only the one marker should differ"
        );
    }

    #[test]
    fn unticks_a_task() {
        let out = toggle(DOC, "1.1 Add users table", 0, false).unwrap();
        assert!(out.contains("- [ ] 1.1 Add users table"));
    }

    #[test]
    fn preserves_bullet_style_and_indentation() {
        let out = toggle(DOC, "2.1 Hash passwords", 0, true).unwrap();
        assert!(out.contains("* [x] 2.1 Hash passwords"), "asterisk kept");

        let out = toggle(DOC, "2.1.1 Pick a cost factor", 0, true).unwrap();
        assert!(out.contains("  - [x] 2.1.1"), "indentation kept");
    }

    #[test]
    fn preserves_crlf_and_a_missing_trailing_newline() {
        let crlf = "- [ ] one\r\n- [ ] two";
        let out = toggle(crlf, "two", 0, true).unwrap();
        assert_eq!(out, "- [ ] one\r\n- [x] two");
        assert!(!out.ends_with('\n'), "no newline was invented");
    }

    #[test]
    fn is_a_no_op_when_the_task_is_already_in_that_state() {
        let out = toggle(DOC, "1.1 Add users table", 0, true).unwrap();
        assert_eq!(out, DOC, "the file is left alone, not rewritten");
    }

    #[test]
    fn addresses_repeated_wording_by_occurrence() {
        let doc = "- [ ] Write tests\n- [x] Something else\n- [ ] Write tests\n";
        let first = toggle(doc, "Write tests", 0, true).unwrap();
        assert_eq!(first, "- [x] Write tests\n- [x] Something else\n- [ ] Write tests\n");

        let second = toggle(doc, "Write tests", 1, true).unwrap();
        assert_eq!(second, "- [ ] Write tests\n- [x] Something else\n- [x] Write tests\n");
    }

    #[test]
    fn refuses_when_the_task_has_gone() {
        // The file may have been rewritten since it was read; better to fail
        // loudly than to tick whatever now sits on that line.
        let err = toggle(DOC, "a task that never existed", 0, true).unwrap_err();
        assert!(err.to_string().contains("no longer in this file"));
    }

    #[test]
    fn refuses_an_occurrence_that_is_not_there() {
        let err = toggle(DOC, "1.2 Add login endpoint", 3, true).unwrap_err();
        assert!(err.to_string().contains("not 4"), "got: {err}");
    }

    #[test]
    fn ignores_things_that_only_look_like_checkboxes() {
        let doc = "- [] no space\n- [y] wrong marker\n[ ] no bullet\n- [ ] real\n";
        let found = checkboxes(doc);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].text, "real");
    }

    #[test]
    fn writes_only_a_changes_tasks_file() {
        assert!(is_change_tasks_file(Path::new(
            "/p/openspec/changes/add-auth/tasks.md"
        )));
        // Everything else, including specs and the project's own files.
        for bad in [
            "/p/openspec/specs/billing/spec.md",
            "/p/openspec/changes/add-auth/proposal.md",
            "/p/tasks.md",
            "/p/openspec/tasks.md",
            "/p/src/main.rs",
        ] {
            assert!(!is_change_tasks_file(Path::new(bad)), "should refuse {bad}");
        }
    }

    #[test]
    fn ticks_a_task_on_disk_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let change = dir.path().join("openspec/changes/add-auth");
        std::fs::create_dir_all(&change).unwrap();
        let path = change.join("tasks.md");
        std::fs::write(&path, DOC).unwrap();

        set_done(&path, "1.2 Add login endpoint", 0, true).unwrap();
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("- [x] 1.2 Add login endpoint"));

        // No scratch file is left beside it.
        let strays: Vec<_> = std::fs::read_dir(&change)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("speck-tmp"))
            .collect();
        assert!(strays.is_empty(), "temp file left behind");
    }

    #[test]
    fn leaves_the_file_untouched_when_the_task_cannot_be_found() {
        let dir = tempfile::tempdir().unwrap();
        let change = dir.path().join("openspec/changes/c");
        std::fs::create_dir_all(&change).unwrap();
        let path = change.join("tasks.md");
        std::fs::write(&path, DOC).unwrap();

        assert!(set_done(&path, "not here", 0, true).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), DOC);
    }
}
