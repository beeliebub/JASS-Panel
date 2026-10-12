// Decides which screen to show from the daemon's answer about the caller. Unavailable is shown as unavailable, never as a redirect,
// and only an unauthenticated answer sends the person to the website's sign-in page.
import { useEffect, useState } from "react";
import { meSchema, type PanelUser } from "@shared/api.js";
import { createApiClient, PanelApiError, type ApiClient } from "./api/client";
import { NoAccessScreen } from "./features/errors/AccessScreens";
import { AddServer } from "./features/servers/AddServer";
import { ServerDetail } from "./features/servers/ServerDetail";
import { ServerList } from "./features/servers/ServerList";
import { HealthScreen } from "./features/health/HealthScreen";
import { AccessScreen } from "./features/access/AccessScreen";
import { AuditScreen } from "./features/audit/AuditScreen";
import { SettingsScreen } from "./features/settings/SettingsScreen";
import { StateMessage } from "./components/StateMessage";
import { parseRoute, routePath, type Route } from "./lib/router";

type Load =
  | { readonly state: "checking" }
  | { readonly state: "signed-in"; readonly user: PanelUser; readonly ownerOrOperator: boolean }
  | { readonly state: "no-access" }
  | { readonly state: "unavailable" }
  | { readonly state: "redirecting" };

export function App({ basePath }: { readonly basePath: string }) {
  const [load, setLoad] = useState<Load>({ state: "checking" });
  const [attempt, setAttempt] = useState(0);
  const [client] = useState<ApiClient>(() =>
    createApiClient({
      basePath,
      onUnauthenticated: (loginUrl) => {
        setLoad({ state: "redirecting" });
        window.location.assign(loginUrl);
      },
    }),
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ state: "checking" });
    client
      .get("/api/v1/me", meSchema, controller.signal)
      .then((me) => {
        setLoad({ state: "signed-in", user: me.user, ownerOrOperator: me.ownerOrOperator });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof PanelApiError && error.code === "no_access") {
          setLoad({ state: "no-access" });
          return;
        }
        if (error instanceof PanelApiError && error.code === "unauthenticated") return;
        setLoad({ state: "unavailable" });
      });
    return () => controller.abort();
  }, [client, attempt]);

  if (load.state === "signed-in") {
    return <Shell basePath={basePath} client={client} user={load.user} ownerOrOperator={load.ownerOrOperator} />;
  }

  return (
    <div className="min-h-screen bg-panel-page text-panel-text">
      {load.state === "checking" && (
        <main className="mx-auto max-w-[600px] px-6 pt-[18vh]">
          <StateMessage title="Checking your sign-in">The panel is asking the website who you are.</StateMessage>
        </main>
      )}
      {load.state === "redirecting" && (
        <main className="mx-auto max-w-[600px] px-6 pt-[18vh]">
          <StateMessage title="Taking you to sign in">The website's sign-in page will bring you back here.</StateMessage>
        </main>
      )}
      {load.state === "no-access" && <NoAccessScreen />}
      {load.state === "unavailable" && (
        <main className="mx-auto max-w-[600px] px-6 pt-[18vh]">
          <StateMessage
            title="Sign-in cannot be checked right now"
            tone="warning"
            live="assertive"
            action={
              <button className="button button-secondary" onClick={() => setAttempt((count) => count + 1)} type="button">
                Try again
              </button>
            }
          >
            The website did not confirm who you are, so the panel shows nothing until it can. Nothing has been changed.
          </StateMessage>
        </main>
      )}
    </div>
  );
}

function Shell({ basePath, client, user, ownerOrOperator }: { readonly basePath: string; readonly client: ApiClient; readonly user: PanelUser; readonly ownerOrOperator: boolean }) {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname, basePath));

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname, basePath));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [basePath]);

  const go = (next: Route) => {
    window.history.pushState({}, "", routePath(basePath, next));
    setRoute(next);
  };

  return (
    <div className="min-h-screen bg-panel-page text-panel-text">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-panel-line bg-panel-sidebar px-6 py-3">
        <nav aria-label="Panel" className="flex flex-wrap items-center gap-4 text-sm">
          <button className="font-extrabold" onClick={() => go({ name: "list" })} type="button">JASS Panel</button>
          <button className="text-panel-muted hover:text-panel-text" onClick={() => go({ name: "access" })} type="button">Access</button>
          <button className="text-panel-muted hover:text-panel-text" onClick={() => go({ name: "audit" })} type="button">Audit</button>
          <button className="text-panel-muted hover:text-panel-text" onClick={() => go({ name: "health" })} type="button">Health</button>
          <button className="text-panel-muted hover:text-panel-text" onClick={() => go({ name: "settings" })} type="button">Settings</button>
        </nav>
        <span className="text-xs text-panel-subtle">
          {user.name ?? user.email} · {user.role === "OWNER" ? "owner" : ownerOrOperator ? "operator" : "admin"}
        </span>
      </header>
      {route.name === "list" && <ServerList basePath={basePath} client={client} onOpen={(id) => go({ name: "server", id })} onAdd={() => go({ name: "add" })} />}
      {route.name === "add" && <AddServer client={client} onCancel={() => go({ name: "list" })} onCreated={(id) => go({ name: "server", id })} />}
      {route.name === "server" && (
        <ServerDetail basePath={basePath} client={client} id={route.id} onBack={() => go({ name: "list" })} />
      )}
      {route.name === "health" && <HealthScreen client={client} />}
      {route.name === "access" && <AccessScreen client={client} canChangeAccess={ownerOrOperator} />}
      {route.name === "audit" && <AuditScreen client={client} />}
      {route.name === "settings" && <SettingsScreen client={client} />}
    </div>
  );
}
