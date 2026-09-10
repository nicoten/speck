//! Watching `openspec/` so the reader stays live.
//!
//! Agents and editors rewrite these files while you are reading them, so a
//! stale view is the normal failure here rather than an edge case. One watcher
//! is active at a time — the project currently open.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const CHANGED_EVENT: &str = "openspec://changed";

/// Coalescing window. Long enough to collapse an editor's write-rename-chmod
/// burst into one refresh, short enough to feel immediate.
const DEBOUNCE: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedPayload {
    pub root: String,
    /// Absolute paths touched in this burst.
    pub paths: Vec<String>,
}

struct Active {
    root: PathBuf,
    _watcher: RecommendedWatcher,
    /// Dropped to tell the coalescing thread to exit.
    _stop: mpsc::Sender<()>,
}

#[derive(Default)]
pub struct WatchState {
    active: Mutex<Option<Active>>,
}

impl WatchState {
    /// Watch `<root>/openspec`, replacing any previously watched project.
    pub fn watch(&self, app: AppHandle, root: &Path) -> anyhow::Result<()> {
        let mut guard = self.active.lock().unwrap();
        if guard.as_ref().is_some_and(|a| a.root == root) {
            return Ok(());
        }
        *guard = None; // stop the previous watcher before starting another

        let target = root.join("openspec");
        if !target.is_dir() {
            return Ok(());
        }

        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })?;
        watcher.watch(&target, RecursiveMode::Recursive)?;

        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let root_string = root.to_string_lossy().to_string();

        std::thread::spawn(move || {
            // Block until something happens, then drain whatever else arrives
            // inside the debounce window.
            while let Ok(first) = rx.recv() {
                if stop_rx.try_recv() == Err(mpsc::TryRecvError::Disconnected) {
                    break;
                }

                let mut paths = collect(first);
                while let Ok(ev) = rx.recv_timeout(DEBOUNCE) {
                    paths.extend(collect(ev));
                }

                paths.sort();
                paths.dedup();
                if paths.is_empty() {
                    continue;
                }
                let _ = app.emit(
                    CHANGED_EVENT,
                    ChangedPayload {
                        root: root_string.clone(),
                        paths,
                    },
                );
            }
        });

        *guard = Some(Active {
            root: root.to_path_buf(),
            _watcher: watcher,
            _stop: stop_tx,
        });
        Ok(())
    }

    /// Stop watching. Called when the state is replaced or dropped.
    #[allow(dead_code)]
    pub fn unwatch(&self) {
        *self.active.lock().unwrap() = None;
    }
}

fn collect(ev: notify::Result<notify::Event>) -> Vec<String> {
    match ev {
        Ok(ev) => ev
            .paths
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect(),
        Err(_) => Vec::new(),
    }
}
