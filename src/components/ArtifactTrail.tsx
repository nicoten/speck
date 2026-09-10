import { artifactTrail, isComplete } from "../lib/artifact";
import type { ArtifactGroup } from "../lib/types";

/**
 * The annotation beside an artifact: its file count, or its checklist
 * progress. Shared by the sidebar and the reader's progress strip so both
 * report the same thing.
 */
export function ArtifactTrail({ group }: { group: ArtifactGroup }) {
  const label = artifactTrail(group);
  if (!label) return null;
  return (
    <span className={`progress${isComplete(group) ? " progress--complete" : ""}`}>
      {label}
    </span>
  );
}
