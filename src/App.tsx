import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as ipc from "./lib/ipc";
import {
  findByPath,
  findChange,
  firstDoc,
  neighbours,
  type DocRef,
} from "./lib/order";
import type {
  Doc,
  DocContent,
  ProjectEntry,
  ProjectTree,
  Section,
} from "./lib/types";
import { ProjectDashboard } from "./components/ProjectDashboard";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { Reader } from "./components/Reader";
import { ReadingRail } from "./components/ReadingRail";
import { Sidebar } from "./components/Sidebar";
import { AgentPanel } from "./components/AgentPanel";
import { ChangeDashboard } from "./components/ChangeDashboard";
import { GitHubMark } from "./components/GitHubMark";
import { ViewBoundary } from "./components/ViewBoundary";
import { ConfirmRun, type RunKind, type RunRequest } from "./components/ConfirmRun";
import { UpdateNotice } from "./components/UpdateNotice";
import { Welcome } from "./components/Welcome";
import {
  runningFor,
  startSession,
  stopSession,
  useAgentSessions,
  type Authority,
} from "./lib/agent";
import { checkForUpdate, installUpdate, type UpdateState } from "./lib/updates";

const RAIL_WIDTH = "speck:rail-width";

/** github.com itself, or an Enterprise host named after it. */
const isGitHub = (host: string) =>
  host === "github.com" || host.startsWith("github.");

export default function App() {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [tree, setTree] = useState<ProjectTree | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  /** Bumped on every project load, so views reading files re-read them. A
   *  document's identity does not change when its contents do. */
  const [treeVersion, setTreeVersion] = useState(0);
  /** A change's dashboard, which is a view of the change rather than a file. */
  const [openChange, setOpenChange] = useState<{
    section: Section["kind"];
    name: string;
  } | null>(null);
  const [content, setContent] = useState<DocContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [cliVersion, setCliVersion] = useState<string | null>(null);
  const [repo, setRepo] = useState<ipc.Repo | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [railWidth, setRailWidth] = useState(() =>
    Number(localStorage.getItem(RAIL_WIDTH)) || 268,
  );
  const [update, setUpdate] = useState<UpdateState>({ status: "idle" });
  const [runRequest, setRunRequest] = useState<RunRequest | null>(null);
  const [handoff, setHandoff] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  const { sessions, add: addSession, dismiss: dismissSession } = useAgentSessions();

  const openPathRef = useRef<string | null>(null);
  openPathRef.current = openPath;

  // The watcher subscribes once, so the open project is read from a ref rather
  // than captured: making `tree` an effect dependency tore the listener down and
  // rebuilt it on every reload, and a burst of writes could land in the gap.
  const rootRef = useRef<string | null>(null);
  rootRef.current = tree?.root ?? null;

  // ------------------------------------------------------------- loading

  /** Archived changes start collapsed; the live work is what you came for. */
  const collapsedArchive = (t: ProjectTree) => {
    const keys = new Set<string>();
    for (const section of t.sections) {
      if (section.kind === "archive") {
        for (const change of section.items) keys.add(`archive:${change.name}`);
      }
    }
    return keys;
  };

  const refreshLibrary = useCallback(async () => {
    const list = await ipc.libraryList();
    setProjects(list);
    return list;
  }, []);

  const openDoc = useCallback(async (doc: Doc) => {
    setOpenChange(null);
    setOpenPath(doc.path);
    try {
      setContent(await ipc.readDoc(doc.path));
      setDocError(null);
    } catch (e) {
      setContent(null);
      setDocError(String(e));
    }
  }, []);

  // Ticking a box edits tasks.md; the watcher then reloads and the reader
  // re-reads the file, so the checklist ends up showing what is on disk rather
  // than what was clicked.
  const toggleTask = useCallback(
    async (path: string, text: string, occurrence: number, done: boolean) => {
      try {
        await ipc.setTaskDone(path, text, occurrence, done);
        setDocError(null);
      } catch (e) {
        setDocError(String(e));
      }
    },
    [],
  );

  /** The project overview: no document and no change selected. */
  const showHome = useCallback(() => {
    setOpenPath(null);
    setOpenChange(null);
    setContent(null);
    setDocError(null);
  }, []);

  const showChange = useCallback(
    (section: Section["kind"], name: string) => {
      setOpenPath(null);
      setContent(null);
      setDocError(null);
      setOpenChange({ section, name });
    },
    [],
  );

  const openProject = useCallback(
    async (path: string, keepDoc = false): Promise<boolean> => {
      try {
        const next = await ipc.loadProject(path);
        setTree(next);
        setTreeVersion((v) => v + 1);
        setError(null);
        if (!keepDoc) setCollapsed(collapsedArchive(next));
        // Best effort: a project need not be in a repository at all.
        void ipc
          .projectRepo(next.root)
          .then(setRepo)
          .catch(() => setRepo(null));

        // Keep reading the same document across a refresh when it survived.
        if (keepDoc) {
          // A refresh keeps you where you were, unless the document has gone.
          const stay = openPathRef.current
            ? findByPath(next, openPathRef.current)
            : undefined;
          if (openPathRef.current && !stay) {
            setOpenPath(null);
            setContent(null);
          }
        }
        return true;
      } catch (e) {
        setError(String(e));
        setTree(null);
        return false;
      }
    },
    [openDoc],
  );

  // Look for a newer release once, in the background. A failure here must not
  // interfere with reading, so it only ever surfaces as a dismissable line.
  useEffect(() => {
    void checkForUpdate().then(setUpdate);
  }, []);

  // Reopen where you left off. The library is sorted most-recently-opened
  // first, so the first entry that still exists is the one to restore; if it
  // fails to load, fall through to the next rather than landing on an error.
  useEffect(() => {
    void (async () => {
      setCliVersion(await ipc.cliInfo());
      const list = await refreshLibrary();
      for (const entry of list.filter((p) => p.available)) {
        if (await openProject(entry.path)) return;
      }
    })();
  }, [openProject, refreshLibrary]);

  // Agents and editors rewrite these files while they are being read, so a
  // stale view is the expected failure. Reload the tree on any change, and the
  // open document when it is the file that moved.
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;

    void ipc
      .onProjectChanged(async ({ root, paths }) => {
        if (root !== rootRef.current) return;
        const touched =
          openPathRef.current !== null && paths.includes(openPathRef.current);
        await openProject(root, true);
        if (touched && openPathRef.current) {
          try {
            setContent(await ipc.readDoc(openPathRef.current));
          } catch {
            /* the refreshed tree already reflects the file going away */
          }
        }
      })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else off = unlisten;
      });

    return () => {
      cancelled = true;
      off?.();
    };
  }, [openProject]);

  const addProject = useCallback(async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Choose a folder that contains an openspec directory",
    });
    if (typeof picked !== "string") return;
    try {
      const entry = await ipc.libraryAdd(picked);
      await refreshLibrary();
      await openProject(entry.path);
    } catch (e) {
      setError(String(e));
    }
  }, [openProject, refreshLibrary]);

  const removeProject = useCallback(
    async (path: string) => {
      await ipc.libraryRemove(path);
      await refreshLibrary();
    },
    [refreshLibrary],
  );

  // ------------------------------------------------------- agent handoff

  // Apply and propose are agent workflows, not CLI commands, so both start a
  // Claude session. In-app runs stream their activity to the panel; the
  // terminal option hands off to a session Speck does not watch. Either way the
  // agent's real progress arrives through the watcher, as ticked tasks.
  const beginRun = useCallback(
    async (opts: {
      action: ipc.AgentAction;
      authority: Authority;
      terminal: boolean;
    }): Promise<boolean> => {
      if (!tree) return false;
      setHandoff({ busy: true, error: null });
      try {
        const started = await startSession(
          tree.root,
          opts.action,
          opts.terminal ? "terminal" : { inApp: { authority: opts.authority } },
        );
        if (started) addSession(started);
        setHandoff({ busy: false, error: null });
        return true;
      } catch (e) {
        setHandoff({ busy: false, error: String(e) });
        return false;
      }
    },
    [tree, addSession],
  );

  const confirmRun = useCallback(
    async (opts: { idea?: string; authority: Authority; terminal: boolean }) => {
      if (!runRequest) return;
      const { kind, change } = runRequest;
      const action: ipc.AgentAction =
        kind === "propose"
          ? { kind: "propose", idea: opts.idea ?? "" }
          : { kind, change: change ?? "" };
      if (await beginRun({ action, authority: opts.authority, terminal: opts.terminal })) {
        setRunRequest(null);
      }
    },
    [runRequest, beginRun],
  );

  /** Open the confirmation for a workflow on a named change. */
  const askToRun = useCallback((kind: RunKind, change: string) => {
    setHandoff({ busy: false, error: null });
    setRunRequest({ kind, change });
  }, []);

  const activeSession = tree ? runningFor(sessions, tree.root) : undefined;
  const panelSession = activeSession ?? sessions.find((s) => s.root === tree?.root);

  // ---------------------------------------------------------- navigation

  const nav = useMemo(
    () =>
      tree
        ? neighbours(tree, openPath)
        : { prev: null, next: null, index: -1, total: 0 },
    [tree, openPath],
  );

  const go = useCallback((ref: DocRef) => void openDoc(ref.doc), [openDoc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "[" && nav.prev) {
        e.preventDefault();
        go(nav.prev);
      } else if (e.key === "]" && nav.next) {
        e.preventDefault();
        go(nav.next);
      } else if (e.key === "o") {
        e.preventDefault();
        void addProject();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav, go, addProject]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ------------------------------------------------------- pane divider

  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const w = Math.min(Math.max(e.clientX, 200), 520);
      setRailWidth(w);
    };
    const up = () => {
      setDragging(false);
      localStorage.setItem(RAIL_WIDTH, String(railWidth));
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, [dragging, railWidth]);

  const currentRef = tree && openPath ? findByPath(tree, openPath) ?? null : null;
  // Resolved against the current tree, so a change that is archived or removed
  // underneath the dashboard falls away rather than showing stale numbers.
  const dashboard =
    tree && openChange
      ? findChange(tree, openChange.section, openChange.name)
      : undefined;

  if (!tree) {
    return <Welcome onAdd={addProject} error={error} cliVersion={cliVersion} />;
  }

  return (
    <div className="app">
      <div className="chrome">
      <header className="topbar">
        <ProjectSwitcher
          projects={projects}
          current={tree.root}
          currentName={tree.name}
          onSelect={(p) => void openProject(p)}
          onAdd={addProject}
          onRemove={removeProject}
        />
        <div className="topbar__meta">
          {repo && (
            <button
              className="topbar__repo"
              onClick={() => void ipc.openForgeUrl(tree.root, repo.webUrl).catch(() => {})}
              title={`Open ${repo.owner}/${repo.name} on ${repo.host}`}
            >
              {isGitHub(repo.host) && <GitHubMark />}
              <span>
                {repo.owner}/{repo.name}
              </span>
            </button>
          )}
          <UpdateNotice
            state={update}
            onInstall={() => void installUpdate(setUpdate)}
            onDismiss={() => setUpdate({ status: "idle" })}
          />
        </div>
      </header>

      {tree.warnings.length > 0 && (
        <div className="notice" role="status">
          {tree.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}
      </div>

      <div className="middle" style={{ gridTemplateColumns: `${railWidth}px 1px minmax(0, 1fr)` }}>
        <Sidebar
          tree={tree}
          openPath={openPath}
          onOpen={(doc) => void openDoc(doc)}
          collapsed={collapsed}
          onToggle={toggle}
          onNewChange={() => {
            setHandoff({ busy: false, error: null });
            setRunRequest({ kind: "propose" });
          }}
          onOpenHome={showHome}
          atHome={!openPath && !openChange}
          openChange={dashboard ? openChange!.name : null}
          onOpenChange={(name) => {
            const section = tree.sections.find(
              (s) =>
                (s.kind === "activeChanges" || s.kind === "archive") &&
                s.items.some((c) => c.name === name),
            );
            if (section) showChange(section.kind, name);
          }}
        />
        <div
          className="divider"
          data-dragging={dragging}
          role="separator"
          aria-orientation="vertical"
          onMouseDown={() => setDragging(true)}
        />
        {!openPath && !openChange ? (
          <ViewBoundary key="home" what="project">
            <ProjectDashboard
              tree={tree}
              onOpenDoc={(doc) => void openDoc(doc)}
              onOpenChange={(name) => {
                const section = tree.sections.find(
                  (sec) =>
                    (sec.kind === "activeChanges" || sec.kind === "archive") &&
                    sec.items.some((c) => c.name === name),
                );
                if (section) showChange(section.kind, name);
              }}
              onNewChange={() => {
                setHandoff({ busy: false, error: null });
                setRunRequest({ kind: "propose" });
              }}
              onStartReading={() => {
                const first = firstDoc(tree);
                if (first) void openDoc(first.doc);
              }}
            />
          </ViewBoundary>
        ) : dashboard ? (
          <ViewBoundary key={dashboard.name} what="change">
          <ChangeDashboard
            change={dashboard}
            section={openChange!.section}
            onOpenDoc={(doc) => void openDoc(doc)}
            onRun={
              openChange!.section === "activeChanges"
                ? (kind) => askToRun(kind, dashboard.name)
                : undefined
            }
            applying={activeSession !== undefined}
            refreshKey={treeVersion}
            root={tree.root}
          />
          </ViewBoundary>
        ) : (
          <Reader
            ref_={currentRef}
            content={content}
            error={docError ?? handoff.error ?? error}
            onOpen={(doc) => void openDoc(doc)}
            onApply={(change) => askToRun("apply", change)}
            applying={activeSession !== undefined}
            onToggleTask={(path, text, occurrence, done) =>
              void toggleTask(path, text, occurrence, done)
            }
          />
        )}
      </div>

      {panelSession && (
        <AgentPanel
          session={panelSession}
          onStop={() => void stopSession(panelSession.id).catch(() => {})}
          onDismiss={() => dismissSession(panelSession.id)}
        />
      )}

      {runRequest && (
        <ConfirmRun
          request={runRequest}
          onStart={(opts) => void confirmRun(opts)}
          onCancel={() => setRunRequest(null)}
          error={handoff.error}
          busy={handoff.busy}
        />
      )}

      <ReadingRail
        prev={nav.prev}
        next={nav.next}
        index={nav.index}
        total={nav.total}
        onGo={go}
      />
    </div>
  );
}
