import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { DestructiveActionDialog, matchesConfirmation } from "./DestructiveActionDialog.js";

describe("destructive action confirmation", () => {
  it("requires an exact case-sensitive match without trimming", () => {
    expect(matchesConfirmation("Main", "Main")).toBe(true);
    expect(matchesConfirmation("main", "Main")).toBe(false);
    expect(matchesConfirmation(" Main", "Main")).toBe(false);
  });

  it("renders an accessible dialog and keeps confirmation disabled initially", () => {
    const html = renderToStaticMarkup(
      <DestructiveActionDialog
        consequences={["A final backup is required first."]}
        onCancel={() => undefined}
        onConfirm={() => undefined}
        targetName="Main"
        verb="Delete"
      />,
    );

    expect(html).toContain("<dialog");
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("A final backup is required first.");
    expect(html).toContain("disabled=\"\"");
  });

  it("supports a confirmation phrase that differs from the displayed target", () => {
    const html = renderToStaticMarkup(
      <DestructiveActionDialog
        confirmationText="SHORTEN RETENTION"
        onCancel={() => undefined}
        onConfirm={() => undefined}
        targetName="Audit retention"
        verb="Shorten"
      />,
    );

    expect(html).toContain("Shorten Audit retention");
    expect(html).toContain("SHORTEN RETENTION");
    expect(html).not.toContain("Type <strong class=\"text-panel-text\">Audit retention</strong>");
  });

  it("requires an additional exact word without changing the primary confirmation phrase", () => {
    const html = renderToStaticMarkup(
      <DestructiveActionDialog
        confirmationText="restart everything"
        extraConfirmationText="now"
        onCancel={() => undefined}
        onConfirm={() => undefined}
        targetName="all selected servers"
        verb="Restart"
      />,
    );

    expect(html).toContain("restart everything");
    expect(html).toContain("Also type");
    expect(html).toContain("<strong>now</strong>");
    expect(html.match(/<input/g)).toHaveLength(2);
  });

  it("focuses Cancel first, closes on Escape, and restores the opener focus", () => {
    const opener = document.createElement("button");
    opener.textContent = "Open dialog";
    const host = document.createElement("div");
    document.body.append(opener, host);
    opener.focus();
    const root = createRoot(host);
    let cancelled = false;

    act(() => {
      root.render(
        <DestructiveActionDialog
          onCancel={() => { cancelled = true; }}
          onConfirm={() => undefined}
          targetName="Main"
          verb="Stop"
        />,
      );
    });

    expect(document.activeElement).toBe(host.querySelector("button"));
    const input = host.querySelector("input");
    if (input === null) throw new Error("confirmation input is missing");
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(cancelled).toBe(true);

    act(() => root.unmount());
    expect(document.activeElement).toBe(opener);
    host.remove();
    opener.remove();
  });

  it("renders extra choices above the confirmation, and ignores Escape while the request is in flight", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let cancelled = 0;
    const render = (busy: boolean): void => {
      act(() => {
        root.render(
          <DestructiveActionDialog busy={busy} onCancel={() => { cancelled += 1; }} onConfirm={() => undefined} targetName="Main" verb="Stop">
            <label>Countdown<input defaultValue="60" /></label>
          </DestructiveActionDialog>,
        );
      });
    };
    render(false);
    const inputs = [...host.querySelectorAll("input")];
    expect(inputs).toHaveLength(2);
    expect((inputs[0] as HTMLInputElement).value).toBe("60");
    const escape = (): void => {
      act(() => {
        inputs[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
    };
    render(true);
    escape();
    expect(cancelled).toBe(0);
    render(false);
    escape();
    expect(cancelled).toBe(1);
    act(() => root.unmount());
    host.remove();
  });
});
