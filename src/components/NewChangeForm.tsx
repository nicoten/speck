import { useEffect, useRef, useState } from "react";

/**
 * Describe a change to plan. What you write becomes the argument to
 * `/opsx:propose`, which creates the change and its planning artifacts — it
 * does not touch project code.
 */
export function NewChangeForm({
  onStart,
  onCancel,
  error,
  busy,
}: {
  onStart: (idea: string) => void;
  onCancel: () => void;
  error: string | null;
  busy: boolean;
}) {
  const [idea, setIdea] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    field.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onCancel]);

  const submit = () => {
    if (idea.trim() && !busy) onStart(idea.trim());
  };

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="New change">
      <div className="sheet__panel">
        <h2 className="sheet__title">Plan a new change</h2>
        <p className="sheet__lede">
          Describe what should change. Claude opens in your terminal and writes
          the proposal, specs, design and tasks — it stops before touching code.
        </p>

        <textarea
          ref={field}
          className="sheet__field"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          rows={5}
          placeholder="Add a CSV export to the report toolbar, so a subscriber can take a statement into a spreadsheet."
        />

        {error && (
          <p className="sheet__error" role="alert">
            {error}
          </p>
        )}

        <div className="sheet__actions">
          <button className="button button--quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="button" onClick={submit} disabled={busy || !idea.trim()}>
            {busy ? "Opening terminal…" : "Start in terminal"}
          </button>
        </div>
        <p className="sheet__hint">⌘↵ to start</p>
      </div>
    </div>
  );
}
