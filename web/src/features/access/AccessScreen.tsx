// Who may do what. Anyone with access.manage sees the grants; only an owner may change them, including who is a panel operator.
import { useEffect, useState, type FormEvent } from "react";
import { accessSchema, grantedSchema, revokedSchema, type Grant } from "@shared/features.js";
import { serversListSchema, type ServerView } from "@shared/servers.js";
import { HIGH_RISK_CAPABILITY_NAMES, PANEL_CAPABILITY_NAMES, PANEL_OPERATOR, SERVER_CAPABILITY_NAMES } from "@shared/capabilities.js";
import { PanelApiError, type ApiClient } from "../../api/client";
import { StateMessage } from "../../components/StateMessage";

const field = "rounded-panel border border-panel-line bg-panel-soft px-3 py-2 text-sm";

/** Capabilities that can make code run as the panel's account are labelled wherever they are offered. */
function labelOf(name: string): string {
  return (HIGH_RISK_CAPABILITY_NAMES as readonly string[]).includes(name) ? `${name} (high risk)` : name;
}

export function AccessScreen({ client, canChangeAccess }: { readonly client: ApiClient; readonly canChangeAccess: boolean }) {
  const [data, setData] = useState<{ grants: readonly Grant[]; users: readonly { id: string; email: string; name: string | null }[]; usersFrom: "website" | "seen" | "website-unavailable" } | null>(null);
  const [servers, setServers] = useState<readonly ServerView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState("");
  const [serverId, setServerId] = useState("*");
  const [capability, setCapability] = useState<string>(SERVER_CAPABILITY_NAMES[0] ?? "server.view");
  const [operatorId, setOperatorId] = useState("");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([client.get("/api/v1/access", accessSchema, controller.signal), client.get("/api/v1/servers", serversListSchema, controller.signal)])
      .then(([access, list]) => {
        setData(access);
        setServers(list.servers);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof PanelApiError ? failure.message : "The access list could not be loaded.");
      });
    return () => controller.abort();
  }, [client, version]);

  async function grant(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await client.post("/api/v1/access/grants", grantedSchema, { userId, serverId, capability });
      setVersion((count) => count + 1);
    } catch (failure) {
      setError(failure instanceof PanelApiError ? failure.message : "The grant was not saved.");
    }
  }

  async function revoke(item: Grant): Promise<void> {
    setError(null);
    try {
      await client.delete("/api/v1/access/grants", revokedSchema, { userId: item.userId, serverId: item.serverId, capability: item.capability });
      setVersion((count) => count + 1);
    } catch (failure) {
      setError(failure instanceof PanelApiError ? failure.message : "The grant was not removed.");
    }
  }

  async function designate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await client.post("/api/v1/access/grants", grantedSchema, { userId: operatorId, serverId: "*", capability: PANEL_OPERATOR });
      setOperatorId("");
      setVersion((count) => count + 1);
    } catch (failure) {
      setError(failure instanceof PanelApiError ? failure.message : "The panel operator was not made.");
    }
  }

  async function removeOperator(personId: string): Promise<void> {
    setError(null);
    try {
      await client.delete("/api/v1/access/grants", revokedSchema, { userId: personId, serverId: "*", capability: PANEL_OPERATOR });
      setVersion((count) => count + 1);
    } catch (failure) {
      setError(failure instanceof PanelApiError ? failure.message : "The panel operator status was not removed.");
    }
  }

  const people = data?.users ?? [];
  const nameOf = (id: string) => {
    const person = people.find((candidate) => candidate.id === id);
    return person?.name ?? person?.email ?? id;
  };
  const operators = (data?.grants ?? []).filter((item) => item.capability === PANEL_OPERATOR).map((item) => item.userId);

  return (
    <main className="mx-auto grid max-w-[1000px] gap-5 px-6 pb-12 pt-8">
      <h1 className="text-xl font-extrabold">Access</h1>
      {!canChangeAccess && <p className="text-sm text-panel-muted">You can see the grants. Only an owner or a panel operator can change them.</p>}
      {error !== null && <StateMessage title="Something did not work" tone="error">{error}</StateMessage>}
      {data !== null && data.usersFrom === "seen" && (
        <p className="text-sm text-panel-muted">Only an owner or a panel operator can list the website's accounts, so the people below are those this panel has seen.</p>
      )}
      {data !== null && data.usersFrom === "website-unavailable" && (
        <StateMessage title="The website's accounts could not be listed" tone="warning">
          The website could not be asked just now, so the people below are only those this panel has seen. An account that has never opened the panel is missing until the website can be asked again.
        </StateMessage>
      )}
      {data === null && error === null && <StateMessage title="Loading the grants" />}
      {data !== null && (
        <section aria-label="Panel operators" className="grid gap-3 rounded-panel border border-panel-line bg-panel-surface p-4">
          <h2 className="font-bold">Panel operators</h2>
          <p className="text-sm text-panel-muted">
            A panel operator has the same abilities as the owner: every capability on every server, now and when a server is added later, and
            every panel capability, including the access list, the audit log, settings, adding servers and privileged actions. An operator can
            write grants and make or remove other operators. Removing operator status does not remove grants made separately. This is high risk,
            because the owner's abilities include console and file access as the panel's account.
          </p>
          {operators.length === 0 && <p className="text-sm">No one is a panel operator.</p>}
          {operators.map((personId) => (
            <div className="flex items-center justify-between gap-3 text-sm" key={personId}>
              <span>{nameOf(personId)}</span>
              {canChangeAccess && (
                <button className="button button-secondary" onClick={() => void removeOperator(personId)} type="button">
                  Remove operator status
                </button>
              )}
            </div>
          ))}
          {canChangeAccess && (
            <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void designate(event)}>
              <label className="grid gap-1 text-sm font-bold" htmlFor="operator-person">
                Make a person a panel operator
                <select className={field} id="operator-person" onChange={(event) => setOperatorId(event.target.value)} required value={operatorId}>
                  <option value="">Choose a person</option>
                  {people
                    .filter((person) => !operators.includes(person.id))
                    .map((person) => (
                      <option key={person.id} value={person.id}>{person.name ?? person.email}</option>
                    ))}
                </select>
              </label>
              <button className="button button-primary" type="submit">Make panel operator</button>
            </form>
          )}
        </section>
      )}
      {data !== null && (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs text-panel-subtle">
              <th className="py-2">Person</th>
              <th>Server</th>
              <th>Capability</th>
              <th>Granted by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.grants.map((item) => (
              <tr className="border-t border-panel-line" key={`${item.userId}|${item.serverId}|${item.capability}`}>
                <td className="py-2">{data.users.find((user) => user.id === item.userId)?.email ?? item.userId}</td>
                <td>{item.serverId === "*" ? "all" : item.serverId}</td>
                <td className="font-mono text-xs">{item.capability}</td>
                <td className="text-xs text-panel-subtle">{item.grantedBy}</td>
                <td className="text-right">
                  {canChangeAccess && (
                    <button className="button button-secondary" onClick={() => void revoke(item)} type="button">Revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canChangeAccess && (
        <form className="grid gap-3 rounded-panel border border-panel-line bg-panel-surface p-4 sm:grid-cols-2" onSubmit={(event) => void grant(event)}>
          <label className="grid gap-1 text-sm font-bold" htmlFor="grant-user">
            Person
            <select className={field} id="grant-user" onChange={(event) => setUserId(event.target.value)} required value={userId}>
              <option value="">Choose a person</option>
              {data?.users.map((user) => (
                <option key={user.id} value={user.id}>{user.name ?? user.email}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-bold" htmlFor="grant-server">
            Server
            <select className={field} id="grant-server" onChange={(event) => setServerId(event.target.value)} value={serverId}>
              <option value="*">All servers (panel-wide capabilities)</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>{server.displayName}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-bold" htmlFor="grant-capability">
            Capability
            <select className={field} id="grant-capability" onChange={(event) => setCapability(event.target.value)} value={capability}>
              <optgroup label="Per server">
                {SERVER_CAPABILITY_NAMES.map((name) => (
                  <option key={name} value={name}>{labelOf(name)}</option>
                ))}
              </optgroup>
              <optgroup label="Whole panel">
                {PANEL_CAPABILITY_NAMES.map((name) => (
                  <option key={name} value={name}>{labelOf(name)}</option>
                ))}
              </optgroup>
            </select>
          </label>
          <div className="flex items-end">
            <button className="button button-primary" type="submit">Grant</button>
          </div>
        </form>
      )}
    </main>
  );
}
