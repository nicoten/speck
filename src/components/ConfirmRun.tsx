import { useEffect, useRef, useState } from "react";
import type { Authority } from "../lib/agent";

export interface RunRequest {
  /** Absent for a new change: the idea is typed in the sheet. */
  change?: string;
}

/**
 * The one place the authority a run gets is chosen, stated in terms of what it
 * will do rather than the flag it maps to. Nothing starts until this is
 * answered: an agent about to edit your repository is worth one deliberate
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
  onStart: (opts: { idea?: string; authority: Authority; terminal: boolean }) => void;
  onCancel: () => void;
  error: string | null;
  busy: boolean;
}) {
  const applying = request.change !== undefined;
  const [idea, setIdea] = useState("");
  const [commands, setCommands] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    field.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !busy && onCancel();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onCancel, busy]);

  const ready = applying || idea.trim().length > 0;
  const start = (terminal: boolean) => {
    if (!ready || busy) return;
    onStart({
      idea: applying ? undefined : idea.trim(),
      authority: commands ? "editsAndCommands" : "edits",
      terminal,
    });
  };

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={applying ? "Apply change" : "New change"}>
      <div className="sheet__panel">
        <h2 className="sheet__title">
          {applying ? `Apply ${request.change}` : "Plan a new change"}
        </h2>

        <p className="sheet__lede">
          {applying ? (
            <>
              Claude works through this change's tasks in{" "}
              <strong>this project</strong>, editing files without asking, and
              ticking them off as it goes. You can stop it at any point.
            </>
          ) : (
            <>
              Describe what should change. Claude writes the proposal, specs,
              design and tasks, then stops — planning only, no code.
            </>
          )}
        </p>

        {!applying && (
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

        <label className="sheet__check">
          <input
            type="checkbox"
            checked={commands}
            onChange={(e) => setCommands(e.target.checked)}
          />
          <span>
            Also let it run commands
            <span className="sheet__check-why">
              needed if the tasks build or test; without this, commands are
              refused and the refusals are reported
            </span>
          </span>
        </label>

        {error && (
          <p className="sheet__error" role="alert">
            {error}
          </p>
        )}

        <div className="sheet__actions">
          <button className="button button--quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="button" onClick={() => start(false)} disabled={busy || !ready}>
            {busy ? "Starting…" : applying ? "Apply here" : "Plan it here"}
          </button>
        </div>

        <button
          className="sheet__alt"
          onClick={() => start(true)}
          disabled={busy || !ready}
          title="Speck will not watch a session it does not run"
        >
          Run in my terminal instead
        </button>
      </div>
    </div>
  );
}
