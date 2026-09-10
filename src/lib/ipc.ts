import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ChangedPayload,
  DocContent,
  ProjectEntry,
  ProjectTree,
} from "./types";

export const CHANGED_EVENT = "openspec://changed";

export const loadProject = (path: string) =>
  invoke<ProjectTree>("load_project", { path });

export const readDoc = (path: string) => invoke<DocContent>("read_doc", { path });

export const libraryList = () => invoke<ProjectEntry[]>("library_list");

export const libraryAdd = (path: string) =>
  invoke<ProjectEntry>("library_add", { path });

export const libraryRemove = (path: string) =>
  invoke<void>("library_remove", { path });

export const cliInfo = () => invoke<string | null>("cli_info");

/** Fires when anything under the open project's `openspec/` directory changes. */
export const onProjectChanged = (fn: (p: ChangedPayload) => void) =>
  listen<ChangedPayload>(CHANGED_EVENT, (e) => fn(e.payload));
