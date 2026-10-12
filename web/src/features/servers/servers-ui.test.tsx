import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ServerView } from "@shared/servers.js";
import type { ApiClient } from "../../api/client";
import { parseRoute, routePath } from "../../lib/router";
import { AddServer } from "./AddServer";
import { ServerList } from "./ServerList";

class FakeEventSource {
  close(): void {
    return undefined;
  }
  addEventListener(): void {
    return undefined;
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function view(overrides: Partial<ServerView> = {}): ServerView {
  return {
    id: "alpha",
    capabilities: ["server.view", "power"],
    displayName: "Alpha",
    directory: "/srv/alpha",
    logPath: "logs/latest.log",
    autostart: false,
    updateOnStart: false,
    memory: null,
    state: { known: true, activeState: "active", subState: "running", result: "success", execMainStatus: null, nRestarts: 0, mainPid: 1, activeSince: null, memoryBytes: null, loaded: true },
    lastEnd: null,
    unitEdited: false,
    countdown: null,
    ...overrides,
  };
}

describe("router", () => {
  it("reads the screen from the address under the base path", () => {
    expect(parseRoute("/panel/", "/panel")).toEqual({ name: "list" });
    expect(parseRoute("/panel/servers/new", "/panel")).toEqual({ name: "add" });
    expect(parseRoute("/panel/servers/alpha", "/panel")).toEqual({ name: "server", id: "alpha" });
    expect(parseRoute("/panel/servers/a%20b", "/panel")).toEqual({ name: "server", id: "a b" });
    expect(parseRoute("/elsewhere", "/panel")).toEqual({ name: "list" });
  });

  it("writes an address that parses back to the same screen", () => {
    const path = routePath("/panel", { name: "server", id: "alpha" });
    expect(path).toBe("/panel/servers/alpha");
    expect(parseRoute(path, "/panel")).toEqual({ name: "server", id: "alpha" });
  });
});

describe("AddServer", () => {
  it("sends a Paper preset as a structured command and reports the new id", async () => {
    const post = vi.fn(() => Promise.resolve({ server: view({ id: "beta" }) }));
    const client = { post } as unknown as ApiClient;
    const created = vi.fn();
    act(() => root.render(<AddServer client={client} onCancel={() => undefined} onCreated={created} />));
    await settle();

    const setValue = (id: string, value: string) => {
      const input = container.querySelector<HTMLInputElement>(`#${id}`);
      if (input === null) throw new Error(`no field ${id}`);
      act(() => {
        // React tracks the value it last rendered; writing through the prototype setter makes the change visible to it.
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        descriptor?.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    setValue("server-id", "beta");
    setValue("server-name", "Beta");
    setValue("server-directory", "/srv/beta");
    setValue("extra-flags", "-XX:+UseG1GC   -Dx=1");

    const form = container.querySelector("form");
    if (form === null) throw new Error("no form");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(post).toHaveBeenCalledWith(
      "/api/v1/servers",
      expect.anything(),
      expect.objectContaining({
        id: "beta",
        displayName: "Beta",
        directory: "/srv/beta",
        command: expect.objectContaining({ kind: "paper", extraFlags: ["-XX:+UseG1GC", "-Dx=1"] }) as unknown,
      }),
    );
    expect(created).toHaveBeenCalledWith("beta");
  });
});

describe("ServerList", () => {
  it("shows an unknown state as unknown, never as stopped", async () => {
    const client = {
      get: vi.fn(() => Promise.resolve({ servers: [view({ id: "gamma", displayName: "Gamma", state: { known: false, reason: "systemctl could not be read" } })] })),
    } as unknown as ApiClient;
    act(() => root.render(<ServerList basePath="/panel" client={client} onAdd={() => undefined} onOpen={() => undefined} />));
    await settle();
    expect(container.textContent).toContain("Unknown");
    expect(container.textContent).not.toContain("Stopped");
  });

  it("asks before stopping a running server, and sends nothing until the person confirms", async () => {
    const post = vi.fn(() => Promise.resolve({ state: view().state }));
    const client = { get: vi.fn(() => Promise.resolve({ servers: [view()] })), post } as unknown as ApiClient;
    act(() => root.render(<ServerList basePath="/panel" client={client} onAdd={() => undefined} onOpen={() => undefined} />));
    await settle();
    const stop = [...container.querySelectorAll("button")].find((button) => button.textContent === "Stop");
    expect(stop).toBeDefined();
    act(() => stop?.click());
    expect(container.querySelector("dialog")).not.toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
});
