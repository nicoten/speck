import type { UpdateState } from "../lib/updates";

/**
 * A quiet line in the top bar. Updating is never demanded: the reader works on
 * whatever version is installed, so this offers and gets out of the way.
 */
export function UpdateNotice({
  state,
  onInstall,
  onDismiss,
}: {
  state: UpdateState;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  switch (state.status) {
    case "available":
      return (
        <span className="update">
          <span className="update__text">Version {state.version} is available</span>
          <button className="update__action" onClick={onInstall}>
            Install and restart
          </button>
          <button className="update__dismiss" onClick={onDismiss} aria-label="Dismiss">
            ✕
          </button>
        </span>
      );

    case "downloading":
      return (
        <span className="update">
          <span className="update__text">
            {state.progress === null
              ? "Downloading update…"
              : `Downloading update… ${state.progress}%`}
          </span>
        </span>
      );

    case "ready":
      return (
        <span className="update">
          <span className="update__text">Update installed. Restarting…</span>
        </span>
      );

    case "failed":
      return (
        <span className="update update--failed" title={state.message}>
          <span className="update__text">Could not check for updates</span>
          <button className="update__dismiss" onClick={onDismiss} aria-label="Dismiss">
            ✕
          </button>
        </span>
      );

    default:
      return null;
  }
}
