import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as ipc from "./lib/ipc";
import { findByPath, firstDoc, neighbours, type DocRef } from "./lib/order";
import type { Doc, DocContent, ProjectEntry, ProjectTree } from "./lib/types";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { Reader } from "./components/Reader";
import { ReadingRail } from "./components/ReadingRail";
import { Sidebar } from "./components/Sidebar";
import { UpdateNotice } from "./components/UpdateNotice";
import { Welcome } from "./components/Welcome";
import { checkForUpdate, installUpdate, type UpdateState } from "./lib/updates";

const RAIL_WIDTH = "speck:rail-width";

export default function App() {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [tree, setTree] = useState<ProjectTree | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState<DocContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [cliVersion, setCliVersion] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [railWidth, setRailWidth] = useState(() =>
    Number(localStorage.getItem(RAIL_WIDTH)) || 268,
  );
  const [update, setUpdate] = useState<UpdateState>({ status: "idle" });

  const openPathRef = useRef<string | null>(null);
  openPathRef.current = openPath;

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
    setOpenPath(doc.path);
    try {
      setContent(await ipc.readDoc(doc.path));
      setDocError(null);
    } catch (e) {
      setContent(null);
      setDocError(String(e));
    }
  }, []);

  const openProject = useCallback(
    async (path: string, keepDoc = false): Promise<boolean> => {
      try {
        const next = await ipc.loadProject(path);
        setTree(next);
        setError(null);
        if (!keepDoc) setCollapsed(collapsedArchive(next));

        // Keep reading the same document across a refresh when it survived.
        const stay = keepDoc && openPathRef.current
          ? findByPath(next, openPathRef.current)
          : undefined;
        const target = stay ?? (keepDoc ? undefined : firstDoc(next));
        if (target) await openDoc(target.doc);
        else if (!stay && keepDoc) {
          // The open document went away; fall back to the start.
          const first = firstDoc(next);
          if (first) await openDoc(first.doc);
          else {
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
    const stop = ipc.onProjectChanged(async ({ root, paths }) => {
      if (!tree || root !== tree.root) return;
      const touched = openPathRef.current && paths.includes(openPathRef.current);
      await openProject(root, true);
      if (touched && openPathRef.current) {
        try {
          setContent(await ipc.readDoc(openPathRef.current));
        } catch {
          /* the refreshed tree already reflects the file going away */
        }
      }
    });
    return () => {
      void stop.then((off) => off());
    };
  }, [tree, openProject]);

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

  if (!tree) {
    return <Welcome onAdd={addProject} error={error} cliVersion={cliVersion} />;
  }

  return (
    <div className="app">
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
          <UpdateNotice
            state={update}
            onInstall={() => void installUpdate(setUpdate)}
            onDismiss={() => setUpdate({ status: "idle" })}
          />
          <span>
            schema <code>{tree.schema.name}</code>
            {tree.schema.assumed && " (assumed)"}
          </span>
          <span>
            {tree.source === "cli" ? "read by openspec" : "read by scanner"}
          </span>
        </div>
      </header>

      <div className="middle" style={{ gridTemplateColumns: `${railWidth}px 1px minmax(0, 1fr)` }}>
        <Sidebar
          tree={tree}
          openPath={openPath}
          onOpen={(doc) => void openDoc(doc)}
          collapsed={collapsed}
          onToggle={toggle}
        />
        <div
          className="divider"
          data-dragging={dragging}
          role="separator"
          aria-orientation="vertical"
          onMouseDown={() => setDragging(true)}
        />
        <Reader
          tree={tree}
          ref_={currentRef}
          content={content}
          error={docError ?? error}
          onOpen={(doc) => void openDoc(doc)}
        />
      </div>

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
