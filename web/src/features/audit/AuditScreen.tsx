// The audit trail as the signed-in person may see it. The daemon decides which rows are returned; the page shows what it sends.
import { useEffect, useState } from "react";
import { auditSchema, type AuditRow } from "@shared/features.js";
import { PanelApiError, type ApiClient } from "../../api/client";
import { StateMessage } from "../../components/StateMessage";

export function AuditScreen({ client }: { readonly client: ApiClient }) {
  const [rows, setRows] = useState<readonly AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    client
      .get("/api/v1/audit", auditSchema, controller.signal)
      .then((result) => setRows(result.rows))
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof PanelApiError ? failure.message : "The audit log could not be loaded.");
      });
    return () => controller.abort();
  }, [client]);

  return (
    <main className="mx-auto grid max-w-[1100px] gap-5 px-6 pb-12 pt-8">
      <h1 className="text-xl font-extrabold">Audit log</h1>
      {error !== null && <StateMessage title="The log could not be loaded" tone="error">{error}</StateMessage>}
      {rows === null && error === null && <StateMessage title="Loading the log" />}
      {rows !== null && rows.length === 0 && <StateMessage title="Nothing recorded yet">Changes appear here as people make them.</StateMessage>}
      {rows !== null && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-panel-subtle">
                <th className="py-2">When</th>
                <th>Who</th>
                <th>Server</th>
                <th>Action</th>
                <th>Outcome</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="border-t border-panel-line align-top" key={row.id}>
                  <td className="py-2 whitespace-nowrap">{new Date(row.at).toLocaleString()}</td>
                  <td>{row.userLabel ?? "-"}</td>
                  <td>{row.serverId ?? "-"}</td>
                  <td className="font-mono">{row.action}</td>
                  <td>{row.outcome}</td>
                  <td className="max-w-[320px] break-all font-mono text-panel-subtle">{row.details ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
