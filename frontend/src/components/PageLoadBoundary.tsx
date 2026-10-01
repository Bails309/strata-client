// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/** Catches a page whose code could not be loaded, typically because a new
 *  release replaced the files this tab was built against. Reloading is left
 *  to the user, since it would end their live sessions. */
export default class PageLoadBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="p-8 text-sm">
        <p className="mb-3">This page could not be loaded. Strata may have been updated.</p>
        <button type="button" className="btn-sm" onClick={() => window.location.reload()}>
          Reload Strata
        </button>
      </div>
    );
  }
}
