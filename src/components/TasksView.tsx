import { parseTasks, slugify } from "../lib/markdown/parse";
import { Markdown } from "./Markdown";

/** tasks.md as a read-only checklist with progress. */
export function TasksView({ markdown }: { markdown: string }) {
  const doc = parseTasks(markdown);
  const pct = doc.total > 0 ? Math.round((doc.done / doc.total) * 100) : 0;

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
                <span className="task__box" aria-hidden="true" />
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
