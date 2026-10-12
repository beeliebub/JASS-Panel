// A shared confirmation surface for actions that can change or remove server data.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type DestructiveActionDialogProps = {
  readonly verb: string;
  readonly targetName: string;
  readonly confirmationText?: string;
  readonly extraConfirmationText?: string;
  readonly consequences?: readonly string[];
  readonly disabledReason?: string;
  readonly errorMessage?: string;
  /** Extra choices that belong to this confirmation, shown above the typed confirmation. */
  readonly children?: ReactNode;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly busy?: boolean;
};

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function matchesConfirmation(typed: string, expected: string): boolean {
  return typed === expected;
}

export function DestructiveActionDialog({ verb, targetName, confirmationText = targetName, extraConfirmationText, consequences = [], disabledReason, errorMessage, children, onConfirm, onCancel, busy = false }: DestructiveActionDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [typed, setTyped] = useState("");
  const [extraTyped, setExtraTyped] = useState("");
  const hasDisabledReason = disabledReason !== undefined && disabledReason.length > 0;
  const canConfirm = matchesConfirmation(typed, confirmationText)
    && (extraConfirmationText === undefined || matchesConfirmation(extraTyped, extraConfirmationText))
    && !busy
    && !hasDisabledReason;

  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      openerRef.current?.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      // Closing while the request is in flight would hide its outcome from the person who sent it.
      if (!busy) onCancel();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (focusable === undefined || focusable.length === 0) return;
    const first = focusable.item(0);
    const last = focusable.item(focusable.length - 1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center overflow-y-auto bg-black/70 p-[22px]">
      <dialog
        ref={dialogRef}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        aria-modal="true"
        className="relative m-auto w-full max-w-[520px] rounded-2xl border border-panel-line bg-panel-surface p-[26px] text-panel-text shadow-panel max-[520px]:p-5"
        onCancel={(event) => event.preventDefault()}
        onKeyDown={onKeyDown}
        tabIndex={-1}
      >
        <p className="mb-0 font-mono text-[10px] font-medium uppercase tracking-[.13em] text-panel-danger">Confirmation required</p>
        <h2 className="mb-2 mt-2 [overflow-wrap:anywhere] text-[22px] font-extrabold tracking-[-.02em]" id={`${id}-title`}>{verb} {targetName}</h2>
        <p className="text-[13px] leading-[1.65] text-panel-muted" id={`${id}-description`}>Type <strong className="text-panel-text">{confirmationText}</strong> exactly to confirm this action.</p>
        {consequences.length > 0 && (
          <ul className="my-3.5 list-disc pl-5 text-xs leading-[1.7] text-panel-muted">
            {consequences.map((consequence) => <li key={consequence}>{consequence}</li>)}
          </ul>
        )}
        {hasDisabledReason && <p className="my-3 rounded-[7px] bg-panel-soft px-3 py-2.5 text-xs leading-[1.5] text-panel-muted" role="status">{disabledReason}</p>}
        {errorMessage !== undefined && <p className="my-3 rounded-[7px] bg-panel-danger-soft px-3 py-2.5 text-xs leading-[1.5] text-panel-text" role="alert">{errorMessage}</p>}
        {children}
        <label className="mb-2 mt-[19px] block text-xs font-extrabold text-panel-text" htmlFor={`${id}-confirmation`}>Confirmation text</label>
        <input
          autoComplete="off"
          className="min-h-[46px] w-full rounded-lg border border-panel-line bg-panel-page px-3 text-panel-text"
          id={`${id}-confirmation`}
          onChange={(event) => setTyped(event.currentTarget.value)}
          value={typed}
        />
        {extraConfirmationText !== undefined && <>
          <label className="mb-2 mt-3 block text-xs font-extrabold text-panel-text" htmlFor={`${id}-extra-confirmation`}>Also type <strong>{extraConfirmationText}</strong> exactly</label>
          <input
            autoComplete="off"
            className="min-h-[46px] w-full rounded-lg border border-panel-line bg-panel-page px-3 text-panel-text"
            id={`${id}-extra-confirmation`}
            onChange={(event) => setExtraTyped(event.currentTarget.value)}
            value={extraTyped}
          />
        </>}
        <div className="mt-5 flex justify-end gap-2.5">
          <button className="button button-secondary" disabled={busy} onClick={onCancel} ref={cancelRef} type="button">Cancel</button>
          <button
            className="button button-danger"
            disabled={!canConfirm}
            onClick={onConfirm}
            ref={confirmRef}
            type="button"
          >
            {busy ? "Working…" : verb}
          </button>
        </div>
      </dialog>
    </div>
  );
}
