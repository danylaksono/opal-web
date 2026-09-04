/**
 * Catches a render crash so it takes a section down, not the app (PLAN.md 14).
 *
 * The reason this matters here more than in most apps: projects live on the
 * user's device and nowhere else. A component that throws while drawing a list
 * must not look like a product that lost the work — the bytes are still in
 * OPFS, and the message has to say so, because the user has no server-side copy
 * to reassure themselves with.
 *
 * A boundary catches errors thrown while rendering. It does not catch a
 * rejected promise from an event handler, which is why the panels handle their
 * own failures and this is the floor rather than the plan.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Names the part that failed, so the message can be specific. */
  label: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is where a developer looks and where a bug report gets its
    // stack from; there is no reporting endpoint to send it to, by design.
    console.error(`[opal] ${this.props.label} failed to render`, error, info);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="banner bad" data-testid="error-boundary">
        <p style={{ margin: "0 0 0.5rem" }}>
          <strong>{this.props.label} stopped working.</strong> Your projects are
          still stored on this device — this is a display fault, not lost work.
        </p>
        <p className="note" style={{ margin: "0 0 0.75rem" }}>
          {error.message}
        </p>
        <button
          type="button"
          onClick={() => {
            this.setState({ error: null });
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
