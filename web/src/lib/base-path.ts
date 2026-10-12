// Keep every SPA and API URL under the runtime base path supplied by the daemon.
export const DEFAULT_PANEL_BASE_PATH = "/panel";

export function normalizePanelBasePath(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0 || value[0] !== "/" || value.startsWith("//")) {
    return DEFAULT_PANEL_BASE_PATH;
  }

  const withoutTrailingSlashes = value.replace(/\/+$/, "");
  if (withoutTrailingSlashes.length === 0 || /[?#\\]/.test(withoutTrailingSlashes) || hasControlCharacters(withoutTrailingSlashes)) {
    return DEFAULT_PANEL_BASE_PATH;
  }

  const segments = withoutTrailingSlashes.split("/").slice(1);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return DEFAULT_PANEL_BASE_PATH;
  }

  return withoutTrailingSlashes;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function readPanelBasePath(documentRef: Document): string {
  const content = documentRef.querySelector<HTMLMetaElement>('meta[name="panel-base"]')?.content;
  return normalizePanelBasePath(content);
}

export function panelUrl(basePath: string, routePath: string): string {
  const base = normalizePanelBasePath(basePath);
  const route = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return route === "/" ? `${base}/` : `${base}${route}`;
}

