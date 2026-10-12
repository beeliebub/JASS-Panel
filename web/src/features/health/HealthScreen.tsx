// What the panel depends on, and the one privileged action the health panel offers: turning lingering on, behind the password dialog.
import { useEffect, useState } from "react";
import { healthSchema, privilegedResultSchema, type HealthCheck } from "@shared/features.js";
import { PanelApiError, type ApiClient } from "../../api/client";
import { PasswordDialog } from "../../components/PasswordDialog";
import { StateMessage } from "../../components/StateMessage";

const TONE: Record<HealthCheck["status"], string> = {
  ok: "text-panel-good",
  warning: "text-panel-warn",
  error: "text-panel-danger",
  unknown: "text-panel-muted",
};

export function HealthScreen({ client }: { readonly client: ApiClient }) {
  const [checks, setChecks] = useState<readonly HealthCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    client
      .get("/api/v1/health", healthSchema, controller.signal)
      .then((result) => setChecks(result.checks))
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof PanelApiError ? failure.message : "The health checks could not be run.");
      });
    return () => controller.abort();
  }, [client]);

  async function enableLingering(password: string): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      const result = await client.post("/api/v1/privileged/enable-lingering", privilegedResultSchema, { password });
      setOutput(result.output.length > 0 ? result.output : `Finished with exit status ${result.exitCode ?? "unknown"}.`);
      setAsking(false);
    } catch (failure) {
      setActionError(failure instanceof PanelApiError ? failure.message : "The action did not run.");
    } finally {
      setBusy(false);
    }
  }

  const lingering = checks?.find((check) => check.id === "linger");
  return (
    <main className="mx-auto grid max-w-[900px] gap-5 px-6 pb-12 pt-8">
      <h1 className="text-xl font-extrabold">Health</h1>
      {error !== null && <StateMessage title="The checks could not run" tone="error">{error}</StateMessage>}
      {checks === null && error === null && <StateMessage title="Running the checks" />}
      {checks !== null && (
        <ul className="grid gap-2">
          {checks.map((check) => (
            <li className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-panel-line bg-panel-surface p-4" key={check.id}>
              <div>
                <p className="text-sm font-bold">{check.title}</p>
                <p className="text-xs text-panel-muted">{check.detail}</p>
              </div>
              <span className={`text-sm font-bold ${TONE[check.status]}`}>{check.status}</span>
            </li>
          ))}
        </ul>
      )}
      {lingering?.action === "enable-lingering" && (
        <section className="grid gap-3 rounded-panel border border-panel-warn/40 bg-panel-surface p-4">
          <p className="text-sm">Lingering is off. Turning it on lets this account's servers run at boot and without a login.</p>
          <div>
            <button className="button button-danger" onClick={() => setAsking(true)} type="button">Turn lingering on</button>
          </div>
          {actionError !== null && <p className="text-sm text-panel-danger" role="alert">{actionError}</p>}
        </section>
      )}
      {output !== null && <pre className="whitespace-pre-wrap rounded-panel border border-panel-line bg-panel-soft p-4 font-mono text-xs">{output}</pre>}
      {asking && (
        <PasswordDialog
          busy={busy}
          command="sudo loginctl enable-linger <this account>"
          consequence="Servers keep running after logout and start at boot."
          errorMessage={actionError}
          onCancel={() => setAsking(false)}
          onSubmit={(password) => void enableLingering(password)}
          title="Turn lingering on"
        />
      )}
    </main>
  );
}
