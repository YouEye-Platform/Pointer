"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  getDeploymentCapabilities,
  type DeploymentCapabilities,
} from "@/lib/api";

type State =
  | { kind: "loading" }
  | { kind: "standalone"; capabilities: DeploymentCapabilities | null }
  | { kind: "managed"; capabilities: DeploymentCapabilities }
  | { kind: "error" };

export function AuthAvailabilityGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });

  const detect = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const capabilities = await getDeploymentCapabilities();
      if (
        capabilities.deploymentMode === "managed"
        || capabilities.localAuthAvailable === false
      ) {
        setState({ kind: "managed", capabilities });
      } else {
        setState({ kind: "standalone", capabilities });
      }
    } catch (error) {
      // Older standalone server versions predate capability discovery.
      if (error instanceof ApiError && error.status === 404) {
        setState({ kind: "standalone", capabilities: null });
      } else {
        setState({ kind: "error" });
      }
    }
  }, []);

  useEffect(() => {
    void detect();
  }, [detect]);

  if (state.kind === "standalone") return children;

  if (state.kind === "managed") {
    return (
      <section className="card auth-card stack" aria-labelledby="managed-host-title">
        <div>
          <h1 id="managed-host-title">Managed by your host platform</h1>
          <p className="muted">
            This Pointer service is managed by its host platform. Use host
            Settings → AI to configure models and applications.
          </p>
        </div>
        <p className="muted" role="status">
          Local Pointer sign-in and account creation are unavailable on this
          deployment.
        </p>
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section className="card auth-card stack" aria-labelledby="capability-error-title">
        <div>
          <h1 id="capability-error-title">Unable to check this Pointer service</h1>
          <p className="muted">
            Pointer could not determine whether local sign-in is available.
            Check the Pointer server connection and try again.
          </p>
        </div>
        <button className="btn-primary" type="button" onClick={() => void detect()}>
          Try again
        </button>
      </section>
    );
  }

  return (
    <section className="card auth-card stack" aria-live="polite">
      <h1>Checking Pointer…</h1>
      <p className="muted">Confirming how this service is managed.</p>
    </section>
  );
}
