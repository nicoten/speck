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
