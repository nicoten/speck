// Shared reading of artifact state, used by both the sidebar and the reader's
// progress strip so the two never disagree about what "complete" means.

import type { ArtifactGroup } from "./types";

interface Counted {
  completedTasks: number | null;
  totalTasks: number | null;
}

/** `done/total`, or null when there is no checklist to report. */
export function progressLabel(of: Counted): string | null {
  if (of.totalTasks === null || of.totalTasks === 0) return null;
  return `${of.completedTasks ?? 0}/${of.totalTasks}`;
}

export function isComplete(of: Counted): boolean {
  return (
    of.totalTasks !== null &&
    of.totalTasks > 0 &&
    of.completedTasks === of.totalTasks
  );
}

/**
 * The short annotation for an artifact: how many files it holds, or its
 * checklist progress. Null when the label alone says everything.
 */
export function artifactTrail(group: ArtifactGroup): string | null {
  if (group.missing) return null;
  if (group.nested) return String(group.docs.length);
  return progressLabel(group);
}
