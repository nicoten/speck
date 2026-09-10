import { useEffect, useState } from "react";
import { parseTasks, slugify } from "../lib/markdown/parse";
import { pendingKey, withPending } from "../lib/tasks";
import { Markdown } from "./Markdown";
import { TaskCheckbox } from "./TaskCheckbox";

/**
 * `tasks.md` as a checklist. The boxes are live when a toggle handler is given:
 * the same edit the dashboard makes.
 *
 * A box responds on click rather than waiting for the file. The write, the
 * watcher's coalescing window and a project reload together take over a second
 * on a real project, which is far too long for a control to sit still — so the
 * click is held here and shown as though it had landed, and the file overwrites
 * it either way: new content clears the held toggles, and a refused write drops
 * its own and snaps the box back.
 */
export function TasksView({
  markdown,
  onToggle,
}: {
  markdown: string;
  onToggle?: (
    text: string,
    occurrence: number,
    done: boolean,
  ) => Promise<boolean>;
}) {
  const [pending, setPending] = useState<Map<string, boolean>>(new Map());

  // The file is the authority. Once its content changes, whatever it says wins
  // and the toggles held here have served their purpose.
  useEffect(() => {
    setPending((held) => (held.size > 0 ? new Map() : held));
  }, [markdown]);

  const doc = withPending(parseTasks(markdown), pending);
  const pct = doc.total > 0 ? Math.round((doc.done / doc.total) * 100) : 0;

  const click = async (text: string, occurrence: number, done: boolean) => {
    if (!onToggle) return;
    const key = pendingKey(text, occurrence);
    setPending((held) => new Map(held).set(key, done));
    if (!(await onToggle(text, occurrence, done))) {
      setPending((held) => {
        const next = new Map(held);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <>
      {doc.total > 0 && (
        <div className="tasks__summary">
          <span>
            {doc.done} of {doc.total} done
          </span>
          <span className="meter" role="img" aria-label={`${pct} percent complete`}>
            <span className="meter__fill" style={{ width: `${pct}%` }} />
          </span>
        </div>
      )}

      {doc.groups.map((group, i) => (
        <div className="taskgroup" key={i}>
          {group.title && (
            <h3 className="taskgroup__title" id={slugify(group.title)}>
              {group.title}
            </h3>
          )}
          <ul className="tasklist">
            {group.items.map((item, j) => (
              <li className={`task${item.done ? " task--done" : ""}`} key={j}>
                <TaskCheckbox
                  done={item.done}
                  label={`${item.done ? "Mark not done" : "Mark done"}: ${item.text}`}
                  onToggle={
                    onToggle
                      ? () => void click(item.text, item.occurrence, !item.done)
                      : undefined
                  }
                />
                <span className="task__text">{item.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {doc.total === 0 && <Markdown>{markdown}</Markdown>}
    </>
  );
}
