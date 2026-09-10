import type { ChangeNode, Doc } from "../lib/types";
import { artifactTrail } from "../lib/artifact";

/**
 * The change's progress through its schema artifacts, as a stepper.
 *
 * A filled step is settled; the ring is the step the change is on; hollow steps
 * are not started. That distinction comes from the backend — writing a proposal
 * does not finish it, moving past it does.
 *
 * The steps are also the way between artifacts, which is why they are buttons.
 */
export function ChangeProgress({
  change,
  activeArtifactId,
  onOpen,
}: {
  change: ChangeNode;
  activeArtifactId: string | undefined;
  onOpen: (doc: Doc) => void;
}) {
  const steps = change.artifacts;
  if (steps.length === 0) return null;

  // The filled ground runs through the last settled step's segment, so a
  // complete step sits on green along with its label.
  const lastComplete = steps.reduce(
    (found, step, i) => (step.state === "complete" ? i : found),
    -1,
  );
  const fill = `${((lastComplete + 1) / steps.length) * 100}%`;

  return (
    <nav className="stepper" aria-label={`${change.name} progress`}>
      <span className="stepper__fill" style={{ width: fill }} aria-hidden="true" />

      {steps.map((step) => {
        // Jumping to a step opens its first document; the sidebar is where you
        // pick a particular capability within one.
        const target = step.docs[0];
        const trail = artifactTrail(step);
        return (
          <button
            key={step.id}
            className="stepper__step"
            data-state={step.state}
            onClick={() => target && onOpen(target)}
            disabled={!target}
            aria-current={step.id === activeArtifactId}
            title={
              step.state === "pending"
                ? `${step.label} — not written yet`
                : `Go to ${step.label}`
            }
          >
            <span className="stepper__dot">
              {step.state === "complete" && (
                <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
                  <path
                    d="M2.2 6.3l2.4 2.4L9.8 3.4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </span>
            <span className="stepper__label">
              {step.label}
              {trail && <span className="stepper__trail">{trail}</span>}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
