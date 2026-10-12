// The closed catalogue of actions that need root. Each action is a fixed argv template with validated parameters; nothing a request
// sends can change the program, and the account that lingering is enabled for is the one the daemon runs as, never one named in
// the request. Adding an action is a separate code change, with its own tests.
import { userInfo } from "node:os";

export type PrivilegedActionId = "enable-lingering" | "install-java";

export interface PrivilegedAction {
  readonly id: PrivilegedActionId;
  readonly title: string;
  readonly argv: readonly string[];
  readonly description: string;
}

/** Packages the install-java action may name. Anything else is not installed by the panel. */
export const JAVA_PACKAGES: readonly string[] = ["openjdk-21-jre-headless", "openjdk-25-jre-headless"];

export function catalogue(options: { readonly account?: string; readonly javaPackage?: string } = {}): PrivilegedAction[] {
  const account = options.account ?? userInfo().username;
  const actions: PrivilegedAction[] = [
    {
      id: "enable-lingering",
      title: "Start this account's servers at boot",
      argv: ["loginctl", "enable-linger", account],
      description: "Keeps the panel and its servers running when nobody is logged in, and starts them at boot.",
    },
  ];
  if (options.javaPackage !== undefined) {
    if (!JAVA_PACKAGES.includes(options.javaPackage)) throw new RangeError("that Java package is not in the catalogue");
    actions.push({
      id: "install-java",
      title: "Install a Java runtime",
      argv: ["apt-get", "install", "-y", "--", options.javaPackage],
      description: "Installs the chosen headless Java runtime from the system's package manager.",
    });
  }
  return actions;
}

export function findAction(id: string, actions: readonly PrivilegedAction[]): PrivilegedAction | undefined {
  return actions.find((action) => action.id === id);
}
