import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ServerView } from "@shared/servers.js";
import type { ApiClient } from "../../api/client";
import { ServerDetail } from "./ServerDetail";

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

const view: ServerView = {
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
};

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  // The dialog opens itself with showModal; a DOM without it gets a stand-in that only marks the dialog open.
  if (typeof HTMLDialogElement.prototype.showModal !== "function") {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
    };
  }
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

/** Sets a form control's value the way a person's input does, so React's change handler sees it. */
function setValue(element: HTMLInputElement | HTMLSelectElement, value: string, eventName: "input" | "change"): void {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event(eventName, { bubbles: true }));
}

function buttonNamed(name: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent === name);
}

describe("the stop and restart confirmation", () => {
  it("sends the chosen warning with the action", async () => {
    const post = vi.fn((_path: string, _schema: unknown, _body: unknown) => Promise.resolve({ state: view.state }));
    const client = {
      get: (path: string) => Promise.resolve(path.endsWith("/console") ? { lines: [] } : { server: view }),
      post,
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    } as unknown as ApiClient;

    act(() => {
      root.render(<ServerDetail basePath="/panel" client={client} id="alpha" onBack={() => undefined} />);
    });
    await settle();

    act(() => {
      buttonNamed("Stop")?.click();
    });
    const select = container.querySelector<HTMLSelectElement>("#power-countdown");
    expect(select?.value).toBe("0");
    act(() => {
      if (select !== null) setValue(select, "60", "change");
    });
    const confirmation = container.querySelector<HTMLInputElement>("input[id$='-confirmation']");
    act(() => {
      if (confirmation !== null) setValue(confirmation, "alpha", "input");
    });
    act(() => {
      buttonNamed("stop")?.click();
    });
    await settle();

    expect(post).toHaveBeenCalledWith("/api/v1/servers/alpha/power", expect.anything(), { action: "stop", countdownSeconds: 60 });
  });
});

describe("the start-with-the-machine choice", () => {
  function clientFor(capabilities: string[], put = vi.fn((_path: string, _schema: unknown, _body: unknown) => Promise.resolve({ autostart: true }))) {
    const client = {
      get: (path: string) => Promise.resolve(path.endsWith("/console") ? { lines: [] } : { server: { ...view, capabilities } }),
      post: vi.fn(),
      put,
      patch: vi.fn(),
      delete: vi.fn(),
    } as unknown as ApiClient;
    return { client, put };
  }

  it("shows the stored choice, and changes it for a person who holds the server's settings", async () => {
    const { client, put } = clientFor(["server.view", "power", "settings"]);
    act(() => {
      root.render(<ServerDetail basePath="/panel" client={client} id="alpha" onBack={() => undefined} />);
    });
    await settle();
    expect(container.textContent).toContain("Starts with the machine: no");

    act(() => {
      buttonNamed("Start it with the machine")?.click();
    });
    await settle();
    expect(put).toHaveBeenCalledWith("/api/v1/servers/alpha/autostart", expect.anything(), { enabled: true });
    expect(container.textContent).toContain("Starts with the machine: yes");
  });

  it("shows the choice but no control to a person who does not hold the server's settings", async () => {
    const { client, put } = clientFor(["server.view", "power"]);
    act(() => {
      root.render(<ServerDetail basePath="/panel" client={client} id="alpha" onBack={() => undefined} />);
    });
    await settle();
    expect(container.textContent).toContain("Starts with the machine: no");
    expect(buttonNamed("Start it with the machine")).toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });
});

describe("overlapping power requests", () => {
  const loadingView: ServerView = {
    ...view,
    state: { known: true, activeState: "activating", subState: "start", result: "success", execMainStatus: null, nRestarts: 0, mainPid: 1, activeSince: null, memoryBytes: null, loaded: false },
  };

  /** Opens the stop confirmation, confirms it, and lets the request go. */
  async function confirmStop(): Promise<void> {
    act(() => {
      buttonNamed("Stop")?.click();
    });
    const confirmation = container.querySelector<HTMLInputElement>("input[id$='-confirmation']");
    act(() => {
      if (confirmation !== null) setValue(confirmation, "alpha", "input");
    });
    act(() => {
      buttonNamed("stop")?.click();
    });
    await settle();
  }

  function notice(): string {
    return container.querySelector("[role='status']")?.textContent ?? "";
  }

  it("says while loading that the world may not be saved, instead of promising a save", async () => {
    const client = {
      get: (path: string) => Promise.resolve(path.endsWith("/console") ? { lines: [] } : { server: loadingView }),
      post: vi.fn(() => new Promise<unknown>(() => undefined)),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    } as unknown as ApiClient;
    act(() => {
      root.render(<ServerDetail basePath="/panel" client={client} id="alpha" onBack={() => undefined} />);
    });
    await settle();
    act(() => {
      buttonNamed("Stop")?.click();
    });
    expect(container.textContent).toContain("may not be saved before it stops");
    expect(container.textContent).not.toContain("saved first");
  });

  it("lets only the newest request set the page's notice when it ends, so an earlier reply cannot overwrite it", async () => {
    const replies: ((value: unknown) => void)[] = [];
    const post = vi.fn(() => new Promise<unknown>((resolve) => {
      replies.push(resolve);
    }));
    const client = {
      get: (path: string) => Promise.resolve(path.endsWith("/console") ? { lines: [] } : { server: loadingView }),
      post,
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    } as unknown as ApiClient;
    act(() => {
      root.render(<ServerDetail basePath="/panel" client={client} id="alpha" onBack={() => undefined} />);
    });
    await settle();

    // Two stops are open at once, as they are when a person stops a server that is still loading.
    await confirmStop();
    await confirmStop();
    expect(post).toHaveBeenCalledTimes(2);

    act(() => {
      replies[0]?.({ state: loadingView.state, outcome: "cancelled" });
    });
    await settle();
    expect(notice()).toBe("Stopping the server.");

    act(() => {
      replies[1]?.({ state: loadingView.state, outcome: "done" });
    });
    await settle();
    expect(notice()).toBe("");
  });
});
