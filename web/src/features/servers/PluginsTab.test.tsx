// The plugin screen: a saved token is shown only as saved, a token is sent only when one is typed or removed, and a repository's plugins are
// chosen by name from its release before they are saved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApiClient } from "../../api/client";
import { PluginsTab } from "./PluginsTab";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function typeInto(selector: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(selector);
  if (input === null) throw new Error(`no input ${selector}`);
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  act(() => {
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function buttonsNamed(text: string): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")].filter((button) => button.textContent?.trim() === text);
}

function submit(): void {
  const form = container.querySelector("form");
  act(() => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const SAVED = {
  pluginDir: "plugins",
  sources: [
    { repo: "owner/one", plugins: ["jass-core"], tokenConfigured: true },
    { repo: "owner/two", plugins: [], tokenConfigured: false },
  ],
};

function client(options: { post?: ReturnType<typeof vi.fn>; put?: ReturnType<typeof vi.fn> } = {}) {
  return {
    get: vi.fn(() => Promise.resolve(SAVED)),
    put: options.put ?? vi.fn(() => Promise.resolve({ saved: true })),
    post: options.post ?? vi.fn(() => Promise.resolve({ repo: "owner/two", release: "release-3", plugins: [] })),
  } as unknown as ApiClient;
}

describe("the plugins screen", () => {
  it("shows whether a token is saved for each repository, and never the token itself", async () => {
    act(() => root.render(<PluginsTab canWrite client={client()} serverId="alpha" />));
    await settle();
    expect(container.textContent).toContain("one is saved for this repository");
    expect(container.textContent).toContain("none is saved");
    const token = container.querySelector<HTMLInputElement>("#plugin-token-1");
    expect(token?.type).toBe("password");
    expect(token?.value).toBe("");
  });

  it("sends a token only when one is typed, and sends null when the saved one is removed", async () => {
    const put = vi.fn(() => Promise.resolve({ saved: true }));
    act(() => root.render(<PluginsTab canWrite client={client({ put })} serverId="alpha" />));
    await settle();
    typeInto("#plugin-token-2", "fresh-token");
    submit();
    await settle();
    const first = (put.mock.calls[0] as unknown as [string, unknown, { sources: { repo: string; token?: string | null }[] }])[2];
    expect(first.sources[0]).not.toHaveProperty("token");
    expect(first.sources[1]?.token).toBe("fresh-token");

    act(() => buttonsNamed("Remove the saved token")[0]?.click());
    submit();
    await settle();
    const second = (put.mock.calls[1] as unknown as [string, unknown, { sources: { repo: string; token?: string | null }[] }])[2];
    expect(second.sources[0]?.token).toBeNull();
  });

  it("lists a repository's plugins from its release, and saves the ones chosen by name", async () => {
    const post = vi.fn(() => Promise.resolve({ repo: "owner/two", release: "release-3", plugins: [{ name: "jass-main", asset: "jass-main-2.0.jar" }] }));
    const put = vi.fn(() => Promise.resolve({ saved: true }));
    act(() => root.render(<PluginsTab canWrite client={client({ post, put })} serverId="alpha" />));
    await settle();
    typeInto("#plugin-repo-2", "owner/two");
    act(() => buttonsNamed("List its plugins")[1]?.click());
    await settle();
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box?.checked).toBe(false);
    act(() => box?.click());
    expect(container.textContent).toContain("Installed from this repository: jass-main");
    submit();
    await settle();
    expect(post.mock.calls[0]).toEqual(["/api/v1/servers/alpha/plugin-catalogue", expect.anything(), { repo: "owner/two" }]);
    const body = (put.mock.calls[0] as unknown as [string, unknown, { sources: { repo: string; plugins: string[] }[] }])[2];
    expect(body.sources[1]).toEqual({ repo: "owner/two", plugins: ["jass-main"] });
  });
});
