//! The project library: which OpenSpec projects this app knows about.
//!
//! Persisted as JSON in the app config directory. Entries are paths, never
//! copies of project content.

use crate::openspec::fs_scan;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub path: String,
    pub name: String,
    /// Unix seconds.
    pub added_at: u64,
    pub last_opened: Option<u64>,
    /// False when the path has gone away since it was added. Stale entries are
    /// kept and marked, not silently dropped.
    #[serde(default)]
    pub available: bool,
    /// Set when the entry came from `openspec store list`.
    #[serde(default)]
    pub store_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LibraryFile {
    #[serde(default)]
    projects: Vec<ProjectEntry>,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// The bundle identifier this app used when it was called Speck.
///
/// macOS derives the config directory from the identifier, so renaming the app
/// moved it — and a library saved under the old name would have simply
/// disappeared from the window with the file still sitting on disk.
pub const PREVIOUS_IDENTIFIER: &str = "com.nicotejera.speck";

/// Copy a library saved under the previous identifier into this one, and say
/// whether it did.
///
/// Copied rather than moved, so a downgrade still finds its projects, and only
/// when this identifier has no library of its own — whatever is here now was
/// written by a newer version than whatever is there, so it wins.
pub fn adopt_previous_library(config_dir: &Path, previous: &Path) -> bool {
    let target = config_dir.join("projects.json");
    let source = previous.join("projects.json");
    if target.exists() || !source.exists() {
        return false;
    }
    if std::fs::create_dir_all(config_dir).is_err() {
        return false;
    }
    std::fs::copy(&source, &target).is_ok()
}

pub struct Library {
    file: PathBuf,
}

impl Library {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            file: config_dir.join("projects.json"),
        }
    }

    fn read(&self) -> LibraryFile {
        std::fs::read_to_string(&self.file)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn write(&self, data: &LibraryFile) -> Result<()> {
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&self.file, serde_json::to_string_pretty(data)?)?;
        Ok(())
    }

    /// Saved projects plus any locally registered OpenSpec stores, most
    /// recently opened first.
    pub fn list(&self) -> Vec<ProjectEntry> {
        let mut data = self.read();
        for e in data.projects.iter_mut() {
            e.available = fs_scan::is_project(Path::new(&e.path));
        }

        for store in discovered_stores() {
            if !data.projects.iter().any(|e| e.path == store.path) {
                data.projects.push(store);
            }
        }

        data.projects.sort_by(|a, b| {
            b.last_opened
                .unwrap_or(b.added_at)
                .cmp(&a.last_opened.unwrap_or(a.added_at))
                .then_with(|| a.name.cmp(&b.name))
        });
        data.projects
    }

    pub fn add(&self, path: &Path) -> Result<ProjectEntry> {
        let path = path
            .canonicalize()
            .unwrap_or_else(|_| path.to_path_buf());
        if !fs_scan::is_project(&path) {
            return Err(anyhow!(
                "{} is not an OpenSpec project (no openspec/ directory)",
                path.display()
            ));
        }
        let key = path.to_string_lossy().to_string();

        let mut data = self.read();
        if let Some(existing) = data.projects.iter_mut().find(|e| e.path == key) {
            existing.last_opened = Some(now());
            existing.available = true;
            let out = existing.clone();
            self.write(&data)?;
            return Ok(out);
        }

        let entry = ProjectEntry {
            path: key,
            name: display_name(&path),
            added_at: now(),
            last_opened: Some(now()),
            available: true,
            store_id: None,
        };
        data.projects.push(entry.clone());
        self.write(&data)?;
        Ok(entry)
    }

    pub fn remove(&self, path: &str) -> Result<()> {
        let mut data = self.read();
        data.projects.retain(|e| e.path != path);
        self.write(&data)
    }

    /// Record that a project was opened, so the library stays ordered by use.
    pub fn touch(&self, path: &str) -> Result<()> {
        let mut data = self.read();
        match data.projects.iter_mut().find(|e| e.path == path) {
            Some(e) => e.last_opened = Some(now()),
            None => {
                // A store opened for the first time becomes a real entry.
                data.projects.push(ProjectEntry {
                    path: path.to_string(),
                    name: display_name(Path::new(path)),
                    added_at: now(),
                    last_opened: Some(now()),
                    available: fs_scan::is_project(Path::new(path)),
                    store_id: None,
                });
            }
        }
        self.write(&data)
    }
}

/// Locally registered OpenSpec stores, as reported by the CLI. Best effort: a
/// missing CLI simply means no discovered stores.
fn discovered_stores() -> Vec<ProjectEntry> {
    let Ok(list) = crate::openspec::cli::stores() else {
        return Vec::new();
    };
    list.stores
        .into_iter()
        .filter_map(|s| {
            let path = s.path?;
            let p = PathBuf::from(&path);
            fs_scan::is_project(&p).then(|| ProjectEntry {
                name: s.id.clone(),
                path,
                added_at: 0,
                last_opened: None,
                available: true,
                store_id: Some(s.id),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library_at(dir: &Path, contents: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("projects.json"), contents).unwrap();
    }

    #[test]
    fn carries_the_library_across_from_the_previous_identifier() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("com.nicotejera.speck");
        let new = tmp.path().join("com.nicotejera.specks");
        library_at(&old, r#"{"projects":[]}"#);

        assert!(adopt_previous_library(&new, &old));
        assert_eq!(
            std::fs::read_to_string(new.join("projects.json")).unwrap(),
            r#"{"projects":[]}"#
        );
    }

    #[test]
    fn leaves_the_old_library_where_it_is() {
        // Copied, not moved: a downgrade to the previous version should still
        // find its projects rather than an empty window.
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("com.nicotejera.speck");
        let new = tmp.path().join("com.nicotejera.specks");
        library_at(&old, r#"{"projects":[]}"#);

        adopt_previous_library(&new, &old);
        assert!(old.join("projects.json").exists());
    }

    #[test]
    fn never_overwrites_a_library_that_already_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("com.nicotejera.speck");
        let new = tmp.path().join("com.nicotejera.specks");
        library_at(&old, r#"{"projects":["old"]}"#);
        library_at(&new, r#"{"projects":["current"]}"#);

        assert!(!adopt_previous_library(&new, &old));
        assert_eq!(
            std::fs::read_to_string(new.join("projects.json")).unwrap(),
            r#"{"projects":["current"]}"#
        );
    }

    #[test]
    fn does_nothing_when_there_was_no_previous_library() {
        let tmp = tempfile::tempdir().unwrap();
        let new = tmp.path().join("com.nicotejera.specks");
        assert!(!adopt_previous_library(
            &new,
            &tmp.path().join("com.nicotejera.speck")
        ));
        assert!(!new.join("projects.json").exists());
    }
}
