/**
 * A task's checkbox. Real state, so it is a control rather than an ornament:
 * clicking it edits `tasks.md`.
 */
export function TaskCheckbox({
  done,
  onToggle,
  label,
}: {
  done: boolean;
  onToggle?: () => void;
  label: string;
}) {
  if (!onToggle) {
    return <span className={`taskbox${done ? " taskbox--done" : ""}`} aria-hidden="true" />;
  }
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={label}
      className={`taskbox taskbox--live${done ? " taskbox--done" : ""}`}
      onClick={onToggle}
    />
  );
}
