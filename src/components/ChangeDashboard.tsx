import { useEffect, useState } from "react";
import * as ipc from "../lib/ipc";
import { artifactTrail, isComplete, progressLabel } from "../lib/artifact";
import { parseTasks, type TaskItem } from "../lib/markdown/parse";
import type { ArtifactGroup, ChangeNode, Doc, Section } from "../lib/types";
import { ChangeProgress } from "./ChangeProgress";

/** Tasks are the one thing here that needs a file read, not just the tree. */
function useTasks(change: ChangeNode) {
  const tasksDoc = change.artifacts
    .find((a) => a.id === "tasks")
    ?.docs[0];
  const [state, setState] = useState<{
    remaining: TaskItem[];
    done: TaskItem[];
    loaded: boolean;
  }>({ remaining: [], done: [], loaded: false });

  useEffect(() => {
    if (!tasksDoc) {
      setState({ remaining: [], done: [], loaded: true });
      return;
    }
    let live = true;
    void ipc
      .readDoc(tasksDoc.path)
      .then((content) => {
        if (!live) return;
        const parsed = parseTasks(content.markdown);
        const all = parsed.groups.flatMap((g) => g.items);
        setState({
          remaining: all.filter((t) => !t.done),
          done: all.filter((t) => t.done),
          loaded: true,
        });
      })
      .catch(() => live && setState({ remaining: [], done: [], loaded: true }));
    return () => {
      live = false;
    };
    // Re-read when the file changes underneath: the watcher reloads the tree,
    // which gives this doc a new seq.
  }, [tasksDoc?.path, tasksDoc?.seq]);

  return state;
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
  onApply,
  applying,
}: {
  change: ChangeNode;
  section: Section["kind"];
  onOpenDoc: (doc: Doc) => void;
  onApply?: () => void;
  applying: boolean;
}) {
  const { remaining, done, loaded } = useTasks(change);
  const [showDone, setShowDone] = useState(false);
  const progress = progressLabel(change);
  const total = (change.totalTasks ?? 0) || remaining.length + done.length;
  const pct = total > 0 ? Math.round(((change.completedTasks ?? done.length) / total) * 100) : 0;

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
          {onApply && (
            <button className="button" onClick={onApply} disabled={applying}>
              {applying ? "Running…" : "Apply"}
            </button>
          )}
        </header>

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
          <ul className="dash__tasks">
            {remaining.map((task, i) => (
              <li className="dash__task" key={i}>
                <span className="dash__box" aria-hidden="true" />
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
                {done.map((task, i) => (
                  <li className="dash__task dash__task--done" key={i}>
                    <span className="dash__box dash__box--done" aria-hidden="true" />
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
