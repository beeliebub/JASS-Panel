// The panel operator card: an owner makes a person an operator with one panel-wide grant and removes it the same way; anyone else sees who
// the operators are and gets no controls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApiClient } from "../../api/client";
import { AccessScreen } from "./AccessScreen";

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

function choose(selector: string, value: string): void {
  const select = container.querySelector<HTMLSelectElement>(selector);
  if (select === null) throw new Error(`no select ${selector}`);
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  act(() => {
    descriptor?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function buttonsNamed(text: string): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")].filter((button) => button.textContent?.trim() === text);
}

const ACCESS = {
  grants: [{ userId: "admin-1", serverId: "*", capability: "panel.operator", grantedBy: "owner-1", grantedAt: "now" }],
  users: [
    { id: "admin-1", email: "admin@example.net", name: "Alice", lastSeen: "now" },
    { id: "admin-2", email: "two@example.net", name: null, lastSeen: "now" },
  ],
  usersFrom: "website",
};

function client(access: unknown = ACCESS) {
  const get = vi.fn((path: string) => Promise.resolve(path === "/api/v1/access" ? access : { servers: [] }));
  const post = vi.fn(() => Promise.resolve({ granted: true }));
  const del = vi.fn(() => Promise.resolve({ revoked: true }));
  return { api: { get, post, delete: del } as unknown as ApiClient, post, del };
}

describe("the panel operator card", () => {
  it("makes a person a panel operator with one panel-wide grant, offering only people who are not operators yet", async () => {
    const fake = client();
    act(() => root.render(<AccessScreen client={fake.api} canChangeAccess />));
    await settle();
    const options = [...(container.querySelector<HTMLSelectElement>("#operator-person")?.options ?? [])].map((option) => option.value);
    expect(options).toEqual(["", "admin-2"]);
    choose("#operator-person", "admin-2");
    act(() => {
      container.querySelector("section[aria-label='Panel operators'] form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(fake.post).toHaveBeenCalledWith("/api/v1/access/grants", expect.anything(), { userId: "admin-2", serverId: "*", capability: "panel.operator" });
  });

  it("removes the operator status with the same wildcard row", async () => {
    const fake = client();
    act(() => root.render(<AccessScreen client={fake.api} canChangeAccess />));
    await settle();
    act(() => buttonsNamed("Remove operator status")[0]?.click());
    await settle();
    expect(fake.del).toHaveBeenCalledWith("/api/v1/access/grants", expect.anything(), { userId: "admin-1", serverId: "*", capability: "panel.operator" });
  });

  it("shows the operators to someone who may see the screen, with no controls", async () => {
    const fake = client();
    act(() => root.render(<AccessScreen client={fake.api} canChangeAccess={false} />));
    await settle();
    expect(container.textContent).toContain("Alice");
    expect(container.querySelector("#operator-person")).toBeNull();
    expect(buttonsNamed("Remove operator status")).toHaveLength(0);
  });

  it("offers an account the website lists even though this panel has never seen it", async () => {
    const fake = client({ ...ACCESS, users: [...ACCESS.users, { id: "fresh-1", email: "fresh@example.net", name: null, lastSeen: null }] });
    act(() => root.render(<AccessScreen client={fake.api} canChangeAccess />));
    await settle();
    const options = [...(container.querySelector<HTMLSelectElement>("#operator-person")?.options ?? [])].map((option) => option.value);
    expect(options).toContain("fresh-1");
    expect(container.textContent).not.toContain("could not be listed");
  });

  it("says so when the website could not be asked, and offers only the people this panel has seen", async () => {
    const fake = client({ ...ACCESS, usersFrom: "website-unavailable" });
    act(() => root.render(<AccessScreen client={fake.api} canChangeAccess />));
    await settle();
    expect(container.textContent).toContain("could not be listed");
    expect(container.textContent).toContain("only those this panel has seen");
  });

  it("explains that the website's accounts are for owners and operators, to anyone else who may see the screen", async () => {
    const fake = client({ ...ACCESS, usersFrom: "seen" });
    act(() => root.render(<AccessScreen client={fake.api} canChangeAccess />));
    await settle();
    expect(container.textContent).toContain("Only an owner or a panel operator can list the website's accounts");
    expect(container.textContent).not.toContain("could not be listed");
  });
});
