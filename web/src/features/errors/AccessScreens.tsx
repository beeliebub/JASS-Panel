// Terminal states shown only after the signed-in SPA has loaded.
import type { PanelUser } from "@shared/api.js";
import { StateMessage } from "../../components/StateMessage.js";

export function NoAccessScreen({ user }: { readonly user?: PanelUser }) {
  return (
    <main className="mx-auto grid min-h-screen max-w-[600px] content-start gap-6 px-6 pb-12 pt-[18vh] max-[520px]:px-4 max-[520px]:pb-9 max-[520px]:pt-[13vh]">
      <div className="flex items-center gap-2.5 text-[13px] font-extrabold text-panel-muted"><span aria-hidden="true" className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-panel-accent text-lg text-panel-accent-ink">J</span> JASS Panel</div>
      <StateMessage title="No access to anything yet" tone="warning">
        {user === undefined ? "This account" : (user.name ?? user.email)}, an owner has not granted any panel or server capabilities to this account.
      </StateMessage>
      <p className="-mt-2.5 ml-[43px] text-xs leading-[1.6] text-panel-subtle">You can close this page and return after your access is updated.</p>
    </main>
  );
}

export function AccessDeniedScreen({ onBack }: { readonly onBack: () => void }) {
  return (
    <div className="mx-auto my-[30px] max-w-[620px]">
      <StateMessage title="You do not have access to this area" tone="warning" action={<button className="button button-secondary" onClick={onBack} type="button">Return to dashboard</button>}>
        This destination is not available to your current account.
      </StateMessage>
    </div>
  );
}

export function NotFoundScreen({ onBack }: { readonly onBack: () => void }) {
  return (
    <div className="mx-auto my-[30px] max-w-[620px]">
      <StateMessage title="Page not found" action={<button className="button button-secondary" onClick={onBack} type="button">Return to dashboard</button>}>
        The address may be out of date or the requested item may no longer exist.
      </StateMessage>
    </div>
  );
}

