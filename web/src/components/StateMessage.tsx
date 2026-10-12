// Consistent, announced empty, loading, and failure states for the shell and feature screens.
import type { ReactNode } from "react";

export type StateMessageProps = {
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly tone?: "neutral" | "warning" | "error";
  readonly live?: "polite" | "assertive" | "off";
};

export function StateMessage({ title, children, action, tone = "neutral", live = "polite" }: StateMessageProps) {
  const toneClass = tone === "error"
    ? "border-panel-danger/40 bg-panel-danger/5"
    : tone === "warning"
      ? "border-panel-warn/40 bg-panel-warn/5"
      : "";
  const markClass = tone === "error" ? "text-panel-danger" : tone === "warning" ? "text-panel-warn" : "text-panel-accent";
  return (
    <section aria-live={live} className={`flex items-start gap-4 rounded-panel border border-panel-line bg-panel-surface p-5 ${toneClass}`} role={tone === "error" ? "alert" : "status"}>
      <div className={`mt-px inline-flex h-7 w-7 flex-none items-center justify-center rounded-full border border-panel-line bg-panel-soft font-mono font-medium ${markClass}`} aria-hidden="true">{tone === "error" ? "!" : tone === "warning" ? "·" : "i"}</div>
      <div className="min-w-0">
        <h2 className="mb-2 text-[15px] font-extrabold leading-[1.45]">{title}</h2>
        {children !== undefined && <div className="text-[13px] leading-[1.65] text-panel-muted">{children}</div>}
        {action !== undefined && <div className="mt-3.5">{action}</div>}
      </div>
    </section>
  );
}

