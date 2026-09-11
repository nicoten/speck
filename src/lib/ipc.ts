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

export interface Repo {
  host: string;
  owner: string;
  name: string;
  webUrl: string;
}

export interface PullRequest {
  number: number;
  title: string;
  /** OPEN, MERGED or CLOSED, as the forge reports it. */
  state: string;
  url: string;
  isDraft: boolean;
}

/** How the pull requests were found. Inference, so the UI says which. */
export type PullRequestBasis = "branch" | "commits";

/**
 * OpenSpec records no pull request: there is no field for one and nothing in
 * the CLI knows about branches. So this is inference, by two strategies — a
 * branch named after the change, then pull requests containing commits that
 * touched the change's own files. The answer says which one matched, because a
 * guess should not read as a recorded fact.
 */
export type PullRequestLookup =
  | { status: "found"; pullRequests: PullRequest[]; basis: PullRequestBasis }
  | { status: "none"; branch: string }
  | { status: "unavailable"; reason: string };

export const projectRepo = (path: string) =>
  invoke<Repo | null>("project_repo", { path });

export const changePullRequest = (path: string, change: string) =>
  invoke<PullRequestLookup>("change_pull_request", { path, change });

/** Opens a link belonging to the project's own forge, and nothing else. */
export const openForgeUrl = (path: string, url: string) =>
  invoke<void>("open_forge_url", { path, url });

export const cliInfo = () => invoke<string | null>("cli_info");

/**
 * Hand an OpenSpec workflow to a Claude session in the user's terminal.
 *
 * The action is structured rather than a command line: the app can name a
 * change or describe an idea, and nothing else.
 */
export type AgentAction =
  | { kind: "apply"; change: string }
  | { kind: "verify"; change: string }
  | { kind: "archive"; change: string }
  | { kind: "propose"; idea: string };

/**
 * Tick a task off, or un-tick it — the only write Specks makes to a project.
 *
 * The task is named by its text and, where the same wording repeats, by which
 * occurrence. Not by line number: the file may have been rewritten since it was
 * read, and a line number would then tick the wrong task silently.
 */
export const setTaskDone = (
  path: string,
  text: string,
  occurrence: number,
  done: boolean,
) => invoke<void>("set_task_done", { path, text, occurrence, done });

export const startAgentSession = (path: string, action: AgentAction) =>
  invoke<void>("start_agent_session", { path, action });

/** Fires when anything under the open project's `openspec/` directory changes. */
export const onProjectChanged = (fn: (p: ChangedPayload) => void) =>
  listen<ChangedPayload>(CHANGED_EVENT, (e) => fn(e.payload));
