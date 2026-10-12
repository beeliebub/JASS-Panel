// Turns the browser address into one of the panel's screens. Addresses are kept under the base path the daemon was configured with.
export type Route =
  | { readonly name: "list" }
  | { readonly name: "add" }
  | { readonly name: "server"; readonly id: string }
  | { readonly name: "health" }
  | { readonly name: "access" }
  | { readonly name: "audit" }
  | { readonly name: "settings" };

const PANEL_PAGES: Readonly<Record<string, Route["name"]>> = { health: "health", access: "access", audit: "audit", settings: "settings" };

export function parseRoute(pathname: string, basePath: string): Route {
  const rest = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : "";
  const segments = rest.split("/").filter((segment) => segment.length > 0);
  const [first, second] = segments;
  if (first === "servers" && second === "new" && segments.length === 2) return { name: "add" };
  if (first === "servers" && second !== undefined && segments.length === 2) return { name: "server", id: decodeURIComponent(second) };
  const page = first === undefined ? undefined : PANEL_PAGES[first];
  if (page !== undefined && segments.length === 1) return { name: page } as Route;
  return { name: "list" };
}

export function routePath(basePath: string, route: Route): string {
  if (route.name === "add") return `${basePath}/servers/new`;
  if (route.name === "server") return `${basePath}/servers/${encodeURIComponent(route.id)}`;
  if (route.name === "health" || route.name === "access" || route.name === "audit" || route.name === "settings") return `${basePath}/${route.name}`;
  return `${basePath}/`;
}
