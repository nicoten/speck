import type { ChangeNode, ProjectTree, SpecNode } from "../lib/types";
import { Markdown } from "./Markdown";

/** Every spec in the tree, flattened, with its requirement count. */
function flatSpecs(nodes: SpecNode[]): SpecNode[] {
  return nodes.flatMap((n) => [...(n.doc ? [n] : []), ...flatSpecs(n.children)]);
}

function counts(tree: ProjectTree) {
  let active: ChangeNode[] = [];
  let archive: ChangeNode[] = [];
  let specs: SpecNode[] = [];

  for (const section of tree.sections) {
    if (section.kind === "activeChanges") active = section.items;
    if (section.kind === "archive") archive = section.items;
    if (section.kind === "specs") specs = flatSpecs(section.items);
  }

  return {
    active: active.length,
    archived: archive.length,
    specs: specs.length,
    requirements: specs.reduce((n, s) => n + (s.requirementCount ?? 0), 0),
    tasksDone: active.reduce((n, c) => n + (c.completedTasks ?? 0), 0),
    tasksTotal: active.reduce((n, c) => n + (c.totalTasks ?? 0), 0),
    latestArchive: archive[0]?.archivedOn ?? null,
  };
}

function Card({
  label,
  count,
  note,
}: {
  label: string;
  count: number;
  note: string;
}) {
  return (
    <div className="card">
      <span className="card__label">{label}</span>
      <span className="card__count">{count}</span>
      <span className="card__note">{note}</span>
    </div>
  );
}

/**
 * The project at a glance: how much of it there is, and what it says it is.
 *
 * Navigation belongs to the sidebar, so the counts are a readout rather than a
 * control. The context is the project's own words about itself — the prose
 * `config.yaml` shows its agents, which is as good an introduction for a person.
 */
export function ProjectDashboard({
  tree,
  onNewChange,
}: {
  tree: ProjectTree;
  onNewChange: () => void;
}) {
  const n = counts(tree);

  return (
    <div className="reader">
      <div className="dash">
        <header className="dash__head">
          <div>
            <h1 className="dash__name">{tree.name}</h1>
          </div>
          <div className="dash__actions">
            <button className="button" onClick={onNewChange}>
              New change
            </button>
          </div>
        </header>

        <div className="cards">
          <Card
            label="Active changes"
            count={n.active}
            note={
              n.tasksTotal > 0
                ? `${n.tasksDone} of ${n.tasksTotal} tasks done`
                : "no tasks written yet"
            }
          />
          <Card
            label="Open specs"
            count={n.specs}
            note={
              n.requirements > 0
                ? `${n.requirements} requirements`
                : "no requirements yet"
            }
          />
          <Card
            label="Archived"
            count={n.archived}
            note={n.latestArchive ? `latest ${n.latestArchive}` : "nothing archived"}
          />
        </div>

        {tree.context ? (
          <section className="dash__section">
            <div className="doc home__context">
              <Markdown>{tree.context}</Markdown>
            </div>
          </section>
        ) : (
          <p className="dash__empty home__nocontext">
            This project has no <code>context</code> in its{" "}
            <code>openspec/config.yaml</code>. It is the prose the project shows
            its agents — stack, conventions, domain — and it would read here.
          </p>
        )}
      </div>
    </div>
  );
}
