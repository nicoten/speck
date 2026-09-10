import { parseTasks, slugify } from "../lib/markdown/parse";
import { Markdown } from "./Markdown";
import { TaskCheckbox } from "./TaskCheckbox";

/**
 * `tasks.md` as a checklist. The boxes are live when a toggle handler is given:
 * the same edit the dashboard makes.
 */
export function TasksView({
  markdown,
  onToggle,
}: {
  markdown: string;
  onToggle?: (text: string, occurrence: number, done: boolean) => void;
}) {
  const doc = parseTasks(markdown);

  // Occurrence counted in document order, so repeated wording stays addressable.
  const seen = new Map<string, number>();
  const occurrenceOf = (text: string) => {
    const at = seen.get(text) ?? 0;
    seen.set(text, at + 1);
    return at;
  };
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
            {group.items.map((item, j) => {
              const occurrence = occurrenceOf(item.text);
              return (
                <li className={`task${item.done ? " task--done" : ""}`} key={j}>
                  <TaskCheckbox
                    done={item.done}
                    label={`${item.done ? "Mark not done" : "Mark done"}: ${item.text}`}
                    onToggle={
                      onToggle
                        ? () => onToggle(item.text, occurrence, !item.done)
                        : undefined
                    }
                  />
                  <span className="task__text">{item.text}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {doc.total === 0 && <Markdown>{markdown}</Markdown>}
    </>
  );
}
