import { useEffect, useState } from "react";
import * as ipc from "../lib/ipc";
import { artifactTrail, isComplete, progressLabel } from "../lib/artifact";
import { parseTasks } from "../lib/markdown/parse";
import type { ArtifactGroup, ChangeNode, Doc, Section } from "../lib/types";
import type { RunKind } from "./ConfirmRun";
import { ChangeProgress } from "./ChangeProgress";
import { PullRequestLink } from "./PullRequestLink";
import { TaskCheckbox } from "./TaskCheckbox";

/** A task, with enough to address it in the file when its box is clicked. */
interface DashTask {
  text: string;
  done: boolean;
  /** Which occurrence of this exact wording, counting from zero. */
  occurrence: number;
}

/**
 * Tasks are the one thing here that needs a file read, not just the tree.
 *
 * Re-read whenever the project reloads: `refreshKey` changes on every load, and
 * the document's identity does not change when its contents do — depending on
 * the doc alone left this stale while an agent ticked boxes underneath it.
 */
function useTasks(change: ChangeNode, refreshKey: number) {
  const tasksDoc = change.artifacts.find((a) => a.id === "tasks")?.docs[0];
  const [tasks, setTasks] = useState<DashTask[] | null>(null);

  useEffect(() => {
    if (!tasksDoc) {
      setTasks([]);
      return;
    }
    let live = true;
    void ipc
      .readDoc(tasksDoc.path)
      .then((content) => {
        if (!live) return;
        const seen = new Map<string, number>();
        setTasks(
          parseTasks(content.markdown)
            .groups.flatMap((g) => g.items)
            .map((item) => {
              const occurrence = seen.get(item.text) ?? 0;
              seen.set(item.text, occurrence + 1);
              return { text: item.text, done: item.done, occurrence };
            }),
        );
      })
      .catch(() => live && setTasks([]));
    return () => {
      live = false;
    };
  }, [tasksDoc?.path, refreshKey]);

  /** Flip locally so the box responds at once; the reload confirms it. */
  const mark = (task: DashTask, done: boolean) =>
    setTasks((prev) =>
      prev?.map((t) =>
        t.text === task.text && t.occurrence === task.occurrence ? { ...t, done } : t,
      ) ?? prev,
    );

  return { tasks, path: tasksDoc?.path, mark };
}

function Artifacts({
  change,
  onOpen,
}: {
  change: ChangeNode;
  onOpen: (doc: Doc) => void;
}) {
  const stateWord = (group: ArtifactGroup) =>
    group.state === "complete"
      ? "settled"
      : group.state === "current"
        ? "in hand"
        : "not written";

  return (
    <ul className="dash__artifacts">
      {change.artifacts.map((group) => (
        <li className="dash__artifact" key={group.id} data-state={group.state}>
          <span className="dash__step">{group.step}</span>
          <span className="dash__artifact-name">{group.label}</span>
          <span className="dash__artifact-state">{stateWord(group)}</span>
          <span className="dash__artifact-files">
            {group.docs.map((doc) => (
              <button key={doc.id} className="dash__file" onClick={() => onOpen(doc)}>
                {doc.title}
              </button>
            ))}
            {group.docs.length === 0 && <span className="dash__nofile">—</span>}
          </span>
          <span className="dash__artifact-trail">
            <ArtifactTrailText group={group} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function ArtifactTrailText({ group }: { group: ArtifactGroup }) {
  const label = artifactTrail(group);
  if (!label) return null;
  return (
    <span className={isComplete(group) ? "dash__done" : undefined}>{label}</span>
  );
}

/**
 * Everything about one change on a page: how far it has got, what is left, and
 * where its documents are.
 *
 * The task list is the point of it. The sidebar can say `5/14`; only this can
 * say which nine things are still open, which is what you want before deciding
 * whether to apply it.
 */
export function ChangeDashboard({
  change,
  section,
  onOpenDoc,
  onRun,
  applying,
  refreshKey,
  root,
}: {
  change: ChangeNode;
  section: Section["kind"];
  onOpenDoc: (doc: Doc) => void;
  /** Absent for archived changes: their workflow is finished. */
  onRun?: (kind: RunKind) => void;
  applying: boolean;
  refreshKey: number;
  root: string;
}) {
  const { tasks, path, mark } = useTasks(change, refreshKey);
  const [showDone, setShowDone] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);

  const loaded = tasks !== null;
  const remaining = tasks?.filter((t) => !t.done) ?? [];
  const done = tasks?.filter((t) => t.done) ?? [];
  const progress = progressLabel(change);
  const total = (tasks?.length ?? 0) || (change.totalTasks ?? 0);
  const pct = total > 0 ? Math.round((done.length / total) * 100) : 0;
  // Unknown counts as work left: better to lead with Apply than to suggest a
  // change is ready to verify when the tasks have not been read yet.
  const tasksLeft = !loaded || remaining.length > 0 || total === 0;

  const toggle = (task: DashTask) => {
    if (!path) return;
    const next = !task.done;
    mark(task, next);
    setTaskError(null);
    void ipc.setTaskDone(path, task.text, task.occurrence, next).catch((e) => {
      // Put it back: the file did not change, so the box should not claim it did.
      mark(task, task.done);
      setTaskError(String(e));
    });
  };

  return (
    <div className="reader">
      <div className="dash">
        <header className="dash__head">
          <div>
            <h1 className="dash__name">{change.name}</h1>
            <p className="dash__meta">
              {change.archivedOn
                ? `Archived ${change.archivedOn}`
                : (change.status ?? "active")}
              {progress && ` · ${progress} tasks`}
            </p>
          </div>
          {onRun && (
            <div className="dash__actions">
              {/* Emphasis follows the workflow: implement while tasks remain,
                  then verify. Archiving is quiet — it rewrites the main specs
                  and moves the change. */}
              <button
                className={`button${tasksLeft ? "" : " button--quiet"}`}
                onClick={() => onRun("apply")}
                disabled={applying}
                title="Work through this change's tasks"
              >
                Apply
              </button>
              <button
                className={`button${tasksLeft ? " button--quiet" : ""}`}
                onClick={() => onRun("verify")}
                disabled={applying}
                title="Check the implementation against this change's specs"
              >
                Verify
              </button>
              <button
                className="button button--quiet"
                onClick={() => onRun("archive")}
                disabled={applying}
                title="Fold the delta specs into the main specs and archive this change"
              >
                Archive
              </button>
            </div>
          )}
        </header>

        {/* Its own row: sharing the header meant competing with three buttons
            for width, which truncated the title while the page had room. */}
        <PullRequestLink root={root} change={change.name} />

        <ChangeProgress
          change={change}
          activeArtifactId={undefined}
          onOpen={onOpenDoc}
        />

        {total > 0 && (
          <div className="dash__meter" role="img" aria-label={`${pct} percent of tasks done`}>
            <span className="dash__meter-fill" style={{ width: `${pct}%` }} />
          </div>
        )}

        <section className="dash__section">
          <h2 className="dash__h2">
            Remaining
            <span className="dash__count">{loaded ? remaining.length : "…"}</span>
          </h2>
          {loaded && remaining.length === 0 && (
            <p className="dash__empty">
              {total === 0
                ? "No tasks written yet."
                : "Every task is ticked off."}
            </p>
          )}
          {taskError && (
            <p className="dash__taskerror" role="alert">
              {taskError}
            </p>
          )}
          <ul className="dash__tasks">
            {remaining.map((task) => (
              <li className="dash__task" key={`${task.text}#${task.occurrence}`}>
                <TaskCheckbox
                  done={false}
                  onToggle={() => toggle(task)}
                  label={`Mark done: ${task.text}`}
                />
                <span>{task.text}</span>
              </li>
            ))}
          </ul>
        </section>

        {done.length > 0 && (
          <section className="dash__section">
            <h2 className="dash__h2">
              <button className="dash__toggle" onClick={() => setShowDone((v) => !v)}>
                {showDone ? "▾" : "▸"} Done
              </button>
              <span className="dash__count">{done.length}</span>
            </h2>
            {showDone && (
              <ul className="dash__tasks">
                {done.map((task) => (
                  <li
                    className="dash__task dash__task--done"
                    key={`${task.text}#${task.occurrence}`}
                  >
                    <TaskCheckbox
                      done
                      onToggle={() => toggle(task)}
                      label={`Mark not done: ${task.text}`}
                    />
                    <span>{task.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="dash__section">
          <h2 className="dash__h2">Documents</h2>
          <Artifacts change={change} onOpen={onOpenDoc} />
        </section>

        {section === "archive" && (
          <p className="dash__note">
            This change is archived. Its delta specs have been folded into the
            current specs.
          </p>
        )}
      </div>
    </div>
  );
}
