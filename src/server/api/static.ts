// Serves the built single-page app under the base path. The index is the only file that depends on configuration: the build
// writes a placeholder for the base path and this module substitutes the configured one. Requests are resolved inside the build
// directory; nothing outside it can be read, whatever the path encodes.
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const PLACEHOLDER = "__PANEL_BASE__";
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".map": "application/json",
};

export interface StaticResponse {
  readonly body: Buffer | string;
  readonly contentType: string;
  readonly cacheControl: string;
}

async function readIndex(webDir: string, basePath: string): Promise<StaticResponse | null> {
  let html: string;
  try {
    html = await readFile(resolve(webDir, "index.html"), "utf8");
  } catch {
    return null;
  }
  return {
    // The build writes the base as "/<placeholder>/" for asset URLs and the bare placeholder in the meta tag. Replacing the
    // slashes together matters: a naive replacement of the placeholder alone leaves "//panel/…", a protocol-relative URL.
    body: html.replaceAll(`/${PLACEHOLDER}/`, `${basePath}/`).replaceAll(PLACEHOLDER, basePath),
    contentType: CONTENT_TYPES[".html"] ?? "text/html; charset=utf-8",
    cacheControl: "no-store",
  };
}

/**
 * Resolves a request path under the base path. Returns the index for the app's own routes (paths with no extension), a file
 * for an asset, and null when the file does not exist or the path tries to leave the build directory.
 */
export async function readStatic(webDir: string, basePath: string, requestPath: string): Promise<StaticResponse | null> {
  if (!requestPath.startsWith(basePath)) return null;
  const rest = requestPath.slice(basePath.length);
  if (rest === "" || rest === "/") return readIndex(webDir, basePath);

  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const root = resolve(webDir);
  const file = resolve(root, `.${decoded}`);
  if (!file.startsWith(root + sep)) return null;

  const extension = extname(file);
  if (extension === "") return readIndex(webDir, basePath);

  try {
    const body = await readFile(file);
    const hashed = decoded.startsWith("/assets/");
    return {
      body,
      contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
      cacheControl: hashed ? "public, max-age=31536000, immutable" : "no-cache",
    };
  } catch {
    return null;
  }
}
