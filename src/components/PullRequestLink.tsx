import { useEffect, useState } from "react";
import * as ipc from "../lib/ipc";

/** The forge's own vocabulary, which people already read at a glance. */
function stateOf(pr: ipc.PullRequest): { text: string; tone: string } {
  if (pr.isDraft) return { text: "draft", tone: "draft" };
  switch (pr.state) {
    case "OPEN":
      return { text: "open", tone: "open" };
    case "MERGED":
      return { text: "merged", tone: "merged" };
    default:
      return { text: "closed", tone: "closed" };
  }
}

/**
 * The pull requests for a change.
 *
 * OpenSpec has no field for one, so these are inferred — and a change is
 * usually touched by more than one pull request anyway: proposing it, applying
 * it, archiving it. All of them are shown, and how they were found is stated,
 * so inference is not mistaken for something the project recorded.
 */
export function PullRequestLink({
  root,
  change,
}: {
  root: string;
  change: string;
}) {
  const [lookup, setLookup] = useState<ipc.PullRequestLookup | null>(null);

  useEffect(() => {
    let live = true;
    setLookup(null);
    void ipc
      .changePullRequest(root, change)
      .then((l) => live && setLookup(l))
      .catch((e) => live && setLookup({ status: "unavailable", reason: String(e) }));
    return () => {
      live = false;
    };
  }, [root, change]);

  if (!lookup) {
    return <p className="prs-note">Looking for pull requests…</p>;
  }

  if (lookup.status === "unavailable") {
    return (
      <p className="prs-note" title={lookup.reason}>
        Pull requests unknown — {lookup.reason}
      </p>
    );
  }

  if (lookup.status === "none") {
    return (
      <p className="prs-note">
        No pull request found on <code>{lookup.branch}</code>, or in commits
        touching this change
      </p>
    );
  }

  // Tolerate a payload without the array rather than throwing: the reason this
  // is defensive is that it was not, and the whole dashboard went down.
  const pullRequests = lookup.pullRequests ?? [];
  if (pullRequests.length === 0) {
    return <p className="prs-note">No pull requests found</p>;
  }

  return (
    <div className="prs">
      {pullRequests.map((pr) => {
        const { text, tone } = stateOf(pr);
        return (
          <button
            key={pr.number}
            className="pr"
            onClick={() => void ipc.openForgeUrl(root, pr.url).catch(() => {})}
            title={`Open pull request #${pr.number} in your browser`}
          >
            <span className={`pr__state pr__state--${tone}`}>{text}</span>
            <span className="pr__number">#{pr.number}</span>
            <span className="pr__title">{pr.title}</span>
          </button>
        );
      })}
      {lookup.basis === "commits" && (
        <p className="prs__basis">
          found from commits touching this change, not from a branch name
        </p>
      )}
    </div>
  );
}
