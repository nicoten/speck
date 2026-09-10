import { useEffect, useRef, useState, type ReactNode } from "react";

export type RunKind = "propose" | "apply" | "verify" | "archive";

export interface RunRequest {
  kind: RunKind;
  /** Absent for `propose`, where the idea is typed in the sheet. */
  change?: string;
}

/** What each workflow does, in terms of what it will change. */
const COPY: Record<
  RunKind,
  { title: (change: string) => string; lede: ReactNode; preferTerminal: boolean }
> = {
  propose: {
    title: () => "Plan a new change",
    lede: (
      <>
        Describe what should change. Claude writes the proposal, specs, design
        and tasks, then stops — planning only, no code.
      </>
    ),
    preferTerminal: false,
  },
  apply: {
    title: (change) => `Apply ${change}`,
    lede: (
      <>
        Claude works through this change's tasks in <strong>this project</strong>
        , ticking them off as it goes.
      </>
    ),
    preferTerminal: false,
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
    preferTerminal: false,
  },
  archive: {
    title: (change) => `Archive ${change}`,
    lede: (
      <>
        Archiving folds this change's delta specs into the main specs and moves
        it into the archive. The workflow <strong>asks how to merge</strong>{" "}
        first, so it is better run in your terminal where you can answer — run
        here and Claude decides alone.
      </>
    ),
    preferTerminal: true,
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
  onStart: (opts: { idea?: string; terminal: boolean }) => void;
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
  const start = (terminal: boolean) => {
    if (!ready || busy) return;
    onStart({ idea: needsIdea ? idea.trim() : undefined, terminal });
  };

  const here = (
    <button
      className={`button${copy.preferTerminal ? " button--quiet" : ""}`}
      onClick={() => start(false)}
      disabled={busy || !ready}
    >
      {busy ? "Starting…" : "Run here"}
    </button>
  );
  const terminal = (
    <button
      className={`button${copy.preferTerminal ? "" : " button--quiet"}`}
      onClick={() => start(true)}
      disabled={busy || !ready}
      title="Speck does not watch a session it does not run"
    >
      {busy ? "Starting…" : "Run in my terminal"}
    </button>
  );

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
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start(false);
            }}
            rows={5}
            placeholder="Add a CSV export to the report toolbar, so a subscriber can take a statement into a spreadsheet."
          />
        )}

        {/* Said once, plainly. There is no lesser mode worth offering: refusing
            commands does not make a session safer, it makes it fail halfway. */}
        <p className="sheet__note">
          Running here, Claude edits files and runs commands in this project
          without asking. You can stop it from the panel at any point.
        </p>

        {error && (
          <p className="sheet__error" role="alert">
            {error}
          </p>
        )}

        {/* The recommended venue is the primary button, which for archive is
            the terminal: its questions need somewhere to be asked. */}
        <div className="sheet__actions">
          <button className="button button--quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {copy.preferTerminal ? (
            <>
              {here}
              {terminal}
            </>
          ) : (
            <>
              {terminal}
              {here}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
