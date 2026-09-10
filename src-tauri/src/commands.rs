//! The IPC surface. Deliberately small: the webview loads a project, reads a
//! document, and manages the library. Nothing here writes to a project.

use crate::agent::session::{Authority, RunningSession, Sessions};
use crate::agent::{self, AgentAction};
use crate::library::{Library, ProjectEntry};
use crate::openspec::{self, DocContent, ProjectTree};
use crate::watch::WatchState;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// Roots loaded during this session. A document read must fall inside one of
/// them, so the webview cannot turn `read_doc` into an arbitrary file reader.
#[derive(Default)]
pub struct Allowed(Mutex<HashSet<PathBuf>>);

pub struct AppState {
    pub library: Library,
    pub allowed: Allowed,
    pub watch: WatchState,
    pub sessions: std::sync::Arc<Sessions>,
}

impl AppState {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            library: Library::new(config_dir),
            allowed: Allowed::default(),
            watch: WatchState::default(),
            sessions: std::sync::Arc::new(Sessions::default()),
        }
    }
}

/// Errors cross the IPC boundary as strings; the UI shows them verbatim.
type CmdResult<T> = Result<T, String>;

fn to_string_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn load_project(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> CmdResult<ProjectTree> {
    let root = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("{path}: {e}"))?;

    let tree = openspec::load(&root).map_err(to_string_err)?;

    state.allowed.0.lock().unwrap().insert(root.clone());
    let _ = state.library.touch(&tree.root);
    // Keep the reader live against edits made by an agent or editor.
    if let Err(e) = state.watch.watch(app, &root) {
        eprintln!("watch failed for {}: {e}", root.display());
    }
    Ok(tree)
}

#[tauri::command]
pub fn read_doc(state: State<'_, AppState>, path: String) -> CmdResult<DocContent> {
    let file = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("{path}: {e}"))?;

    let allowed = state.allowed.0.lock().unwrap();
    if !allowed.iter().any(|root| file.starts_with(root)) {
        return Err(format!(
            "{} is outside every open project",
            file.display()
        ));
    }
    drop(allowed);

    let markdown = std::fs::read_to_string(&file).map_err(|e| format!("{path}: {e}"))?;
    let mtime_ms = std::fs::metadata(&file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    Ok(DocContent {
        id: relative_id(&allowed_root(&state, &file), &file),
        path: file.to_string_lossy().to_string(),
        markdown,
        mtime_ms,
    })
}

fn allowed_root(state: &State<'_, AppState>, file: &Path) -> PathBuf {
    state
        .allowed
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|root| file.starts_with(root))
        // Deepest matching root wins, for nested projects.
        .max_by_key(|root| root.components().count())
        .cloned()
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn relative_id(root: &Path, file: &Path) -> String {
    file.strip_prefix(root)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/")
}

#[tauri::command]
pub fn library_list(state: State<'_, AppState>) -> Vec<ProjectEntry> {
    state.library.list()
}

#[tauri::command]
pub fn library_add(state: State<'_, AppState>, path: String) -> CmdResult<ProjectEntry> {
    state
        .library
        .add(Path::new(&path))
        .map_err(to_string_err)
}

#[tauri::command]
pub fn library_remove(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    state.library.remove(&path).map_err(to_string_err)
}

/// Whether the CLI was found, and its version. Shown in the UI so a degraded
/// read is explainable.
#[tauri::command]
pub fn cli_info() -> Option<String> {
    openspec::cli::version()
}

/// Where the work should happen.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Venue {
    /// A session inside Speck, streaming its activity to the panel.
    InApp { authority: Authority },
    /// A session in the user's terminal, which Speck does not watch.
    Terminal,
}

/// Start an OpenSpec workflow for a project that is open.
///
/// The project must be one Speck has loaded, so this cannot be pointed at an
/// arbitrary directory, and the action is structured rather than a command
/// line. `InApp` gives the agent authority over the project — that is the
/// point of it, and the panel says so while it runs.
#[tauri::command]
pub fn start_agent_session(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    action: AgentAction,
    venue: Venue,
) -> CmdResult<Option<RunningSession>> {
    let root = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("{path}: {e}"))?;

    if !state.allowed.0.lock().unwrap().contains(&root) {
        return Err(format!("{} is not an open project", root.display()));
    }

    match venue {
        Venue::Terminal => {
            agent::start(&root, &action).map_err(to_string_err)?;
            Ok(None)
        }
        Venue::InApp { authority } => {
            let sessions = std::sync::Arc::clone(&state.sessions);
            agent::session::start(app, sessions, &root, &action, authority)
                .map(Some)
                .map_err(to_string_err)
        }
    }
}

#[tauri::command]
pub fn stop_agent_session(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.sessions.stop(&id).map_err(to_string_err)
}

/// Sessions still in flight, so the UI can rebuild its state after a reload.
#[tauri::command]
pub fn running_sessions(state: State<'_, AppState>) -> Vec<RunningSession> {
    state.sessions.running()
}

/// Tick a task off, or un-tick it.
///
/// The only write this app makes to a project: one character on one line of a
/// change's `tasks.md`. The task is addressed by its text rather than its line,
/// so a file an agent has rewritten in the meantime fails loudly instead of
/// ticking whatever now sits there.
#[tauri::command]
pub fn set_task_done(
    state: State<'_, AppState>,
    path: String,
    text: String,
    occurrence: usize,
    done: bool,
) -> CmdResult<()> {
    let file = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("{path}: {e}"))?;

    let allowed = state.allowed.0.lock().unwrap();
    if !allowed.iter().any(|root| file.starts_with(root)) {
        return Err(format!("{} is outside every open project", file.display()));
    }
    drop(allowed);

    crate::tasks::set_done(&file, &text, occurrence, done).map_err(to_string_err)
}

pub fn init_state(app: &AppHandle) -> AppState {
    let config_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    AppState::new(config_dir)
}
