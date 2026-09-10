import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps one bad view from taking the whole app down.
 *
 * Documents are parsed from disk with a hand-written parser, and views render
 * data crossing a language boundary, so a shape nobody anticipated should cost
 * one panel, not the window. The sidebar stays usable and you can go elsewhere.
 *
 * Reset by giving it a `key` that changes with what it wraps.
 */
export class ViewBoundary extends Component<
  { children: ReactNode; what: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Failed to render ${this.props.what}`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="docerror" role="alert">
        <h2>This {this.props.what} could not be displayed</h2>
        <p>
          Everything else still works — go somewhere else in the sidebar. If it
          keeps happening, the detail below is the place to start.
        </p>
        <pre className="docerror__detail">{error.message}</pre>
      </div>
    );
  }
}
