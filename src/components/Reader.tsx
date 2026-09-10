import { useEffect, useRef } from "react";
import type { Doc, DocContent, ProjectTree } from "../lib/types";
import type { DocRef } from "../lib/order";
import { ChangeProgress } from "./ChangeProgress";
import { DocumentBoundary } from "./DocumentBoundary";
import { CodeView, nonMarkdownLanguage } from "./CodeView";
import { Outline } from "./Outline";
import { SpecView } from "./SpecView";
import { TasksView } from "./TasksView";

interface Props {
  tree: ProjectTree;
  ref_: DocRef | null;
  content: DocContent | null;
  error: string | null;
  onOpen: (doc: Doc) => void;
  onApply: (changeName: string) => void;
  applying: boolean;
  onToggleTask: (
    path: string,
    text: string,
    occurrence: number,
    done: boolean,
  ) => void;
}

/**
 * Every markdown document goes through SpecView, not only specs: it splits
 * headings out as anchored blocks and hands the prose between them to the
 * markdown renderer. A proposal renders as ordinary prose that way, and every
 * heading in every document gets an anchor the outline can link to.
 */
function Body({
  ref_,
  content,
  sourceLanguage,
  onToggleTask,
}: {
  ref_: DocRef;
  content: DocContent;
  sourceLanguage: string | null;
  onToggleTask: Props["onToggleTask"];
}) {
  if (sourceLanguage !== null) {
    return <CodeView markdown={content.markdown} language={sourceLanguage} />;
  }
  if (ref_.doc.kind === "tasks") {
    return (
      <TasksView
        markdown={content.markdown}
        onToggle={(text, occurrence, done) =>
          onToggleTask(content.path, text, occurrence, done)
        }
      />
    );
  }
  return <SpecView markdown={content.markdown} />;
}

/** Heading for the document, distinct from whatever heading the file carries. */
function title(ref_: DocRef): string {
  if (ref_.section === "specs") return ref_.specId ?? ref_.doc.title;
  if (ref_.doc.kind === "specDelta") return `${ref_.doc.title} (delta)`;
  return ref_.doc.title;
}

export function Reader({
  tree,
  ref_,
  content,
  error,
  onOpen,
  onApply,
  applying,
  onToggleTask,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);

  // A new document starts at the top; a refresh of the one already open keeps
  // its place, so an agent writing to that file does not throw the reader.
  const lastPath = useRef<string | null>(null);
  useEffect(() => {
    if (ref_ && ref_.doc.path !== lastPath.current) {
      scroller.current?.scrollTo({ top: 0 });
      lastPath.current = ref_.doc.path;
    }
  }, [ref_]);

  // A file shown as source is code, not prose: it gets a wider measure and no
  // outline, since it has no headings to list.
  const sourceLanguage = content ? nonMarkdownLanguage(content.path) : null;
  const showOutline = content !== null && sourceLanguage === null;

  return (
    <div className="reader" ref={scroller}>
      {ref_?.change && (
        <div className="reader__head">
          <ChangeProgress
            change={ref_.change}
            activeArtifactId={ref_.artifactId}
            onOpen={onOpen}
            onApply={
              ref_.section === "activeChanges"
                ? () => onApply(ref_.change!.name)
                : undefined
            }
            applying={applying}
          />
        </div>
      )}

      {tree.warnings.length > 0 && (
        <div className="notice" role="status">
          {tree.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {ref_ && content && (
        <div
          className="reader__body"
          data-outline={showOutline}
          data-source={sourceLanguage !== null}
        >
          <article className="doc">
            <h1 className="doc__title">{title(ref_)}</h1>
            {/* Keyed on the path so moving to another document clears a
                previous failure. */}
            <DocumentBoundary key={content.path}>
              <Body
                ref_={ref_}
                content={content}
                sourceLanguage={sourceLanguage}
                onToggleTask={onToggleTask}
              />
            </DocumentBoundary>
          </article>
          {showOutline && <Outline markdown={content.markdown} />}
        </div>
      )}

      {!ref_ && !error && (
        <div className="blank">
          <div className="blank__inner">
            <h1>Nothing to read yet</h1>
            <p>
              This project has no documents. Start a change with{" "}
              <code>openspec</code> and it will appear here.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
