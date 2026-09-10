import { useEffect, useRef } from "react";
import type { Session } from "../lib/agent";

function duration(ms: number | null): string | null {
  if (ms === null) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** What the run did, once it is over. */
function Outcome({ session }: { session: Session }) {
  const o = session.outcome;
  if (!o) return null;

  const bits = [
    o.turns !== null ? `${o.turns} turns` : null,
    duration(o.durationMs),
    o.costUsd !== null ? `$${o.costUsd.toFixed(2)}` : null,
  ].filter(Boolean);

  return (
    <div className="agent__outcome">
      {bits.length > 0 && <span>{bits.join(" · ")}</span>}
      {o.denials.length > 0 && (
        <span className="agent__denials">
          refused: {[...new Set(o.denials)].join(", ")} — start again with
          commands allowed if it needed them
        </span>
      )}
      {o.error && <span className="agent__failure">{o.error}</span>}
    </div>
  );
}

/**
 * The live activity of a session. Deliberately a log rather than a transcript:
 * what a reader wants is which file is being touched and whether it is still
 * going, and the real record of progress is `tasks.md` ticking over in the
 * sidebar beside it.
 */
export function AgentPanel({
  session,
  onStop,
  onDismiss,
}: {
  session: Session;
  onStop: () => void;
  onDismiss: () => void;
}) {
  const log = useRef<HTMLDivElement>(null);

  // Follow the tail, which is the point of watching.
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.lines.length]);

  const running = session.status === "running";

  return (
    <section className="agent" data-status={session.status} aria-label="Session activity">
      <header className="agent__head">
        <span className={`agent__dot${running ? " agent__dot--live" : ""}`} aria-hidden="true" />
        <span className="agent__label">{session.label}</span>
        <span className="agent__authority">
          {session.authority === "editsAndCommands" ? "edits + commands" : "edits only"}
        </span>
        <span className="agent__spacer" />
        {running ? (
          <button className="agent__action" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="agent__action" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </header>

      <div className="agent__log" ref={log}>
        {session.lines.map((line) => (
          <p
            key={line.seq}
            className={`agent__line agent__line--${line.kind}${
              line.ok === false ? " agent__line--bad" : ""
            }`}
          >
            {line.text}
          </p>
        ))}
        {running && session.lines.length === 0 && (
          <p className="agent__line agent__line--note">Starting…</p>
        )}
      </div>

      <Outcome session={session} />
    </section>
  );
}
