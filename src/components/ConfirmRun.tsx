import { useEffect, useRef, useState, type ReactNode } from "react";

export type RunKind = "propose" | "apply" | "verify" | "archive";

export interface RunRequest {
  kind: RunKind;
  /** Absent for `propose`, where the idea is typed in the sheet. */
  change?: string;
}

/** What each workflow does, in terms of what it will change. */
const COPY: Record<RunKind, { title: (change: string) => string; lede: ReactNode }> = {
  propose: {
    title: () => "Plan a new change",
    lede: (
      <>
        Describe what should change. Claude writes the proposal, specs, design
        and tasks, then stops — planning only, no code.
      </>
    ),
  },
  apply: {
    title: (change) => `Apply ${change}`,
    lede: (
      <>
        Claude works through this change's tasks in <strong>this project</strong>
        , ticking them off as it goes.
      </>
    ),
  },
  verify: {
    title: (change) => `Verify ${change}`,
    lede: (
      <>
        Claude checks the implementation against this change's specs and reports
        what it finds — which requirements it can and cannot account for. It
        reads, runs checks and reports; it is not meant to change your code.
      </>
    ),
  },
  archive: {
    title: (change) => `Archive ${change}`,
    lede: (
      <>
        Archiving folds this change's delta specs into the main specs and moves
        it into the archive. The workflow <strong>asks how to merge</strong>{" "}
        first, so answer it in the terminal before it does anything.
      </>
    ),
  },
};

/**
 * The one place the authority a run gets is chosen, stated in terms of what it
 * will do rather than the flag it maps to. Nothing starts until this is
 * answered: an agent about to change your repository is worth one deliberate
 * click.
 */
export function ConfirmRun({
  request,
  onStart,
  onCancel,
  error,
  busy,
}: {
  request: RunRequest;
  onStart: (opts: { idea?: string }) => void;
  onCancel: () => void;
  error: string | null;
  busy: boolean;
}) {
  const copy = COPY[request.kind];
  const needsIdea = request.kind === "propose";
  const [idea, setIdea] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    field.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !busy && onCancel();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onCancel, busy]);

  const ready = !needsIdea || idea.trim().length > 0;
  const start = () => {
    if (!ready || busy) return;
    onStart({ idea: needsIdea ? idea.trim() : undefined });
  };

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-label={copy.title(request.change ?? "")}
    >
      <div className="sheet__panel">
        <h2 className="sheet__title">{copy.title(request.change ?? "")}</h2>
        <p className="sheet__lede">{copy.lede}</p>

        {needsIdea && (
          <textarea
            ref={field}
            className="sheet__field"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
            }}
            rows={5}
            placeholder="Add a CSV export to the report toolbar, so a subscriber can take a statement into a spreadsheet."
          />
        )}

        <p className="sheet__note">
          Claude opens in your terminal, in this project, and asks before each
          step it takes.
        </p>

        {error && (
          <p className="sheet__error" role="alert">
            {error}
          </p>
        )}

        <div className="sheet__actions">
          <button className="button button--quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="button" onClick={start} disabled={busy || !ready}>
            {busy ? "Opening terminal…" : "Run in terminal"}
          </button>
        </div>
      </div>
    </div>
  );
}
