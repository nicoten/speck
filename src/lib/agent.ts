// Running an OpenSpec workflow as a Claude session inside Speck.
//
// The backend streams what the agent does; this keeps the running log and the
// outcome. Only the lines a reader can act on are kept — the mapping upstream
// already dropped hooks, token counts and private reasoning.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import type { AgentAction } from "./ipc";

export const AGENT_EVENT = "agent://event";

/** How much the run is allowed to do. */
export type Authority = "edits" | "editsAndCommands";

export type Venue =
  | { inApp: { authority: Authority } }
  | "terminal";

export type AgentEvent =
  | { kind: "started"; sessionId: string; model: string | null; permissionMode: string | null }
  | { kind: "message"; text: string }
  | { kind: "tool"; name: string; detail: string | null }
  | { kind: "toolDone"; ok: boolean }
  | {
      kind: "finished";
      ok: boolean;
      turns: number | null;
      durationMs: number | null;
      costUsd: number | null;
      denials: string[];
      error: string | null;
    }
  | { kind: "failed"; message: string };

type Envelope = AgentEvent & { id: string; root: string; seq: number };

export interface RunningSession {
  id: string;
  root: string;
  label: string;
  authority: Authority;
}

export interface LogLine {
  seq: number;
  kind: "message" | "tool" | "note";
  text: string;
  ok?: boolean;
}

export interface Session extends RunningSession {
  status: "running" | "done" | "failed";
  lines: LogLine[];
  /** Set once the run ends. */
  outcome?: {
    ok: boolean;
    turns: number | null;
    durationMs: number | null;
    costUsd: number | null;
    denials: string[];
    error: string | null;
  };
}

export const startSession = (
  path: string,
  action: AgentAction,
  venue: Venue,
) => invoke<RunningSession | null>("start_agent_session", { path, action, venue });

export const stopSession = (id: string) =>
  invoke<void>("stop_agent_session", { id });

const listRunning = () => invoke<RunningSession[]>("running_sessions");

/** A tool call as one readable line. */
function toolLine(name: string, detail: string | null): string {
  switch (name) {
    case "Read":
      return `Reading ${detail ?? "a file"}`;
    case "Edit":
      return `Editing ${detail ?? "a file"}`;
    case "Write":
      return `Writing ${detail ?? "a file"}`;
    case "Bash":
      return detail ? `$ ${detail}` : "Running a command";
    case "Glob":
    case "Grep":
      return `Searching for ${detail ?? "something"}`;
    default:
      return detail ? `${name}: ${detail}` : name;
  }
}

function apply(session: Session, event: Envelope): Session {
  const line = (line: LogLine): Session => ({
    ...session,
    // The log is unbounded in principle; a long apply is thousands of events,
    // so keep the tail that is worth reading.
    lines: [...session.lines, line].slice(-300),
  });

  switch (event.kind) {
    case "started":
      return line({
        seq: event.seq,
        kind: "note",
        text: `Session started${event.model ? ` on ${event.model}` : ""}`,
      });
    case "message":
      return line({ seq: event.seq, kind: "message", text: event.text.trim() });
    case "tool":
      return line({
        seq: event.seq,
        kind: "tool",
        text: toolLine(event.name, event.detail),
      });
    case "toolDone":
      // Only a failure is worth a line; success is implied by what comes next.
      return event.ok
        ? session
        : line({ seq: event.seq, kind: "note", text: "That tool call failed", ok: false });
    case "finished":
      return {
        ...line({
          seq: event.seq,
          kind: "note",
          text: event.ok ? "Finished" : `Ended with an error`,
          ok: event.ok,
        }),
        status: event.ok ? "done" : "failed",
        outcome: {
          ok: event.ok,
          turns: event.turns,
          durationMs: event.durationMs,
          costUsd: event.costUsd,
          denials: event.denials,
          error: event.error,
        },
      };
    case "failed":
      return {
        ...line({ seq: event.seq, kind: "note", text: event.message, ok: false }),
        status: "failed",
      };
  }
}

/**
 * The sessions Speck knows about, newest first.
 *
 * Running sessions are reloaded on mount: the webview can be reloaded while an
 * agent is working, and losing the panel should not lose the run.
 */
export function useAgentSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    void listRunning().then((running) =>
      setSessions((prev) => {
        const known = new Set(prev.map((s) => s.id));
        const restored: Session[] = running
          .filter((r) => !known.has(r.id))
          .map((r) => ({
            ...r,
            status: "running",
            lines: [{ seq: 0, kind: "note", text: "Reattached to a running session" }],
          }));
        return [...restored, ...prev];
      }),
    );
  }, []);

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;

    void listen<Envelope>(AGENT_EVENT, ({ payload }) => {
      setSessions((prev) => {
        const at = prev.findIndex((s) => s.id === payload.id);
        if (at === -1) {
          // An event for a session this view has not seen: start a record for
          // it rather than dropping the run on the floor.
          const seed: Session = {
            id: payload.id,
            root: payload.root,
            label: "Session",
            authority: "edits",
            status: "running",
            lines: [],
          };
          return [apply(seed, payload), ...prev];
        }
        const next = [...prev];
        next[at] = apply(next[at], payload);
        return next;
      });
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    });

    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const add = useCallback((session: RunningSession) => {
    setSessions((prev) =>
      prev.some((s) => s.id === session.id)
        ? prev
        : [{ ...session, status: "running", lines: [] }, ...prev],
    );
  }, []);

  const dismiss = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  return { sessions, add, dismiss };
}

/** The session running for a project, if any. */
export function runningFor(sessions: Session[], root: string): Session | undefined {
  return sessions.find((s) => s.root === root && s.status === "running");
}
