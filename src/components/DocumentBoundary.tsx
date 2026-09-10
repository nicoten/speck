import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps a bad document from taking the whole app down.
 *
 * The reader parses arbitrary markdown from disk with a hand-written parser, so
 * a shape nobody anticipated should cost you one document, not the window. The
 * sidebar stays usable and you can read something else.
 *
 * Reset by giving it a `key` that changes with the document.
 */
export class DocumentBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Failed to render document", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="docerror" role="alert">
        <h2>This document could not be displayed</h2>
        <p>
          Speck could not render this file. Everything else still works — pick
          another document, or open the file in your editor to see what is
          unusual about it.
        </p>
        <pre className="docerror__detail">{error.message}</pre>
      </div>
    );
  }
}
