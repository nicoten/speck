import type { TaskDoc, TaskGroup, TaskItem } from "./markdown/parse";

/**
 * A task and which occurrence of its wording it is, counting from zero across
 * the whole document. That pair is how a task is addressed for writing — never
 * by line number, since the file may be rewritten between a read and a click.
 */
export interface NumberedTask extends TaskItem {
  occurrence: number;
}

export interface NumberedGroup extends Omit<TaskGroup, "items"> {
  items: NumberedTask[];
}

export interface NumberedDoc extends Omit<TaskDoc, "groups"> {
  groups: NumberedGroup[];
}

/** Toggles clicked but not yet confirmed by the file: key -> intended state. */
export type Pending = ReadonlyMap<string, boolean>;

/**
 * A NUL cannot appear in a task's text, so no wording-and-occurrence pair can
 * collide with another.
 */
export const pendingKey = (text: string, occurrence: number) =>
  `${text}\u0000${occurrence}`;

/**
 * Number a document's tasks and show any pending toggle as though the file had
 * already caught up, summary counts included.
 *
 * The file remains the authority: a pending entry is dropped once the reload
 * arrives, or when the write is refused, so what is on screen converges on what
 * is on disk rather than on what was clicked. An entry naming a task that is no
 * longer in the file applies to nothing — it cannot resurrect a deleted row.
 */
export function withPending(doc: TaskDoc, pending: Pending): NumberedDoc {
  const seen = new Map<string, number>();
  let done = 0;
  let total = 0;

  const groups = doc.groups.map((group) => ({
    ...group,
    items: group.items.map((item) => {
      const occurrence = seen.get(item.text) ?? 0;
      seen.set(item.text, occurrence + 1);
      const intended = pending.get(pendingKey(item.text, occurrence));
      const isDone = intended ?? item.done;
      total += 1;
      if (isDone) done += 1;
      return { ...item, occurrence, done: isDone };
    }),
  }));

  return { ...doc, groups, done, total };
}
