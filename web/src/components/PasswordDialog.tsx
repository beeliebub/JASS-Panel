// Asks for the account password before a privileged action. The value lives only in this component's field until it is handed to
// onSubmit, and the field is cleared then; it is never stored elsewhere in the page.
import { useId, useState, type FormEvent } from "react";

export function PasswordDialog({
  title,
  command,
  consequence,
  busy,
  errorMessage,
  onSubmit,
  onCancel,
}: {
  readonly title: string;
  readonly command: string;
  readonly consequence: string;
  readonly busy: boolean;
  readonly errorMessage: string | null;
  readonly onSubmit: (password: string) => void;
  readonly onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const id = useId();

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const value = password;
    setPassword("");
    onSubmit(value);
  }

  return (
    <div aria-labelledby={`${id}-title`} aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog">
      <form className="grid w-full max-w-[520px] gap-4 rounded-panel border border-panel-line bg-panel-raised p-6" onSubmit={submit}>
        <h2 className="text-base font-extrabold" id={`${id}-title`}>{title}</h2>
        <p className="text-sm text-panel-muted">{consequence}</p>
        <p className="text-xs text-panel-subtle">This command will run as root, after sudo checks your password:</p>
        <code className="break-all rounded-panel bg-panel-soft p-3 font-mono text-xs">{command}</code>
        <label className="grid gap-1 text-sm font-bold" htmlFor={`${id}-password`}>
          Account password
          <input
            autoComplete="current-password"
            className="rounded-panel border border-panel-line bg-panel-soft px-3 py-2 text-sm"
            id={`${id}-password`}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </label>
        {errorMessage !== null && <p className="text-sm text-panel-danger" role="alert">{errorMessage}</p>}
        <div className="flex justify-end gap-3">
          <button className="button button-secondary" onClick={onCancel} type="button">Cancel</button>
          <button className="button button-danger" disabled={busy || password.length === 0} type="submit">Run as root</button>
        </div>
      </form>
    </div>
  );
}
