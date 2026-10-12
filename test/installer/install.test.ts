// The installer runs against fake systemctl, loginctl and node on the PATH, in a temporary home and a temporary copy of the
// checkout. No test touches the real user manager, the real configuration or a real game server.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const INSTALLER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "install.sh");

let root: string;
let home: string;
let bin: string;
let checkout: string;
let log: string;

const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE_LOG"
case "$*" in
  "--user is-system-running") echo "\${FAKE_MANAGER:-running}"; [ "\${FAKE_MANAGER:-running}" = offline ] && exit 1; exit 0 ;;
  "--version") echo "systemd \${FAKE_SYSTEMD:-259} (test)"; exit 0 ;;
  "--user is-active --quiet"*) [ "\${FAKE_ACTIVE:-no}" = yes ]; exit $? ;;
  *) exit 0 ;;
esac
`;

const FAKE_LOGINCTL = `#!/usr/bin/env bash
echo "\${FAKE_LINGER:-yes}"
`;

const FAKE_OLD_NODE = `#!/usr/bin/env bash
echo 20.11.0
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-install-"));
  home = join(root, "home");
  bin = join(root, "bin");
  checkout = join(root, "checkout with % and $ in its name");
  log = join(root, "calls.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  mkdirSync(join(checkout, "dist", "server"), { recursive: true });
  copyFileSync(INSTALLER, join(checkout, "scripts", "install.sh"));
  chmodSync(join(checkout, "scripts", "install.sh"), 0o755);
  writeFileSync(join(checkout, "dist", "server", "main.js"), "// stub daemon for the installer test\n");
  writeFileSync(join(bin, "systemctl"), FAKE_SYSTEMCTL);
  writeFileSync(join(bin, "loginctl"), FAKE_LOGINCTL);
  for (const tool of ["systemctl", "loginctl"]) chmodSync(join(bin, tool), 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(env: Record<string, string> = {}, options: { node?: string } = {}) {
  if (options.node !== undefined) {
    writeFileSync(join(bin, "node"), options.node);
    chmodSync(join(bin, "node"), 0o755);
  }
  const result = spawnSync("bash", [join(checkout, "scripts", "install.sh")], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      USER: "tester",
      FAKE_LOG: log,
      PANEL_PUBLIC_ORIGIN: "https://example.net",
      ...env,
    },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function calls(): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
}

const unitPath = () => join(home, ".config", "systemd", "user", "jass-panel.service");
const envPath = () => join(home, ".config", "jass-panel", "panel.env");

describe("install.sh refuses with the exact fix", () => {
  it("stops when the systemd user manager is not running", () => {
    const result = run({ FAKE_MANAGER: "offline" });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("the systemd user manager is not running for tester");
    expect(existsSync(unitPath())).toBe(false);
  });

  it("stops when lingering is off and prints the command to enable it", () => {
    const result = run({ FAKE_LINGER: "no" });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("sudo loginctl enable-linger tester");
    expect(existsSync(unitPath())).toBe(false);
    expect(existsSync(envPath())).toBe(false);
  });

  it("stops on a Node.js older than 22.12", () => {
    const result = run({}, { node: FAKE_OLD_NODE });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("Node.js is 20.11.0");
  });

  it("stops when the daemon has not been built", () => {
    rmSync(join(checkout, "dist"), { recursive: true, force: true });
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("npm ci && npm run build");
  });

  it("stops when a required tool is missing and names it", () => {
    // Only the fakes and a node are on the PATH, so tar is absent.
    writeFileSync(join(bin, "node"), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
    chmodSync(join(bin, "node"), 0o755);
    const result = spawnSync("/bin/bash", [join(checkout, "scripts", "install.sh")], {
      encoding: "utf8",
      env: { PATH: bin, HOME: home, USER: "tester", FAKE_LOG: log, PANEL_PUBLIC_ORIGIN: "https://example.net" },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("tar is not installed");
  });

  it("stops without a public origin and says what to pass", () => {
    const result = run({ PANEL_PUBLIC_ORIGIN: "" });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("PANEL_PUBLIC_ORIGIN=https://example.net");
  });
});

describe("install.sh installs", () => {
  it("writes a 0600 environment file, a unit with quoted arguments, enables and starts it, and prints the proxy snippet", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(readFileSync(envPath(), "utf8")).toContain("PANEL_PUBLIC_ORIGIN=https://example.net");
    expect(statSync(envPath()).mode & 0o777).toBe(0o600);

    const unit = readFileSync(unitPath(), "utf8");
    // A plain unit value is escaped too: a literal % in the path is written as %%.
    expect(unit).toContain(`WorkingDirectory=${checkout.replaceAll("%", "%%")}`);
    expect(unit).toContain(`EnvironmentFile=${envPath()}`);
    // The checkout path contains a % and a $, which systemd would expand; both must be escaped in the ExecStart argument.
    expect(unit).toMatch(/ExecStart=".+" ".+checkout with %% and \$\$ in its name\/dist\/server\/main\.js"/);
    expect(unit).toContain("WantedBy=default.target");

    expect(calls()).toEqual(
      expect.arrayContaining(["systemctl --user daemon-reload", "systemctl --user enable jass-panel.service", "systemctl --user start jass-panel.service"]),
    );
    expect(result.out).toContain("@panel path /panel /panel/*");
    expect(result.out).toContain("handle @panel {");
    expect(result.out).toContain("reverse_proxy 127.0.0.1:29200");
    expect(result.out).toContain("This script does not change the proxy.");
  });

  it("warns about a systemd older than 259 and carries on", () => {
    const result = run({ FAKE_SYSTEMD: "258" });
    expect(result.status).toBe(0);
    expect(result.out).toContain("systemd 258 is older than 259");
    expect(existsSync(unitPath())).toBe(true);
  });

  it("changes nothing the second time: the unit is unchanged, the environment file is kept, and nothing restarts", () => {
    expect(run().status).toBe(0);
    const unitBefore = readFileSync(unitPath(), "utf8");
    writeFileSync(envPath(), "PANEL_PUBLIC_ORIGIN=https://example.net\nPANEL_PORT=31000\n");
    writeFileSync(log, "");

    const second = run({ FAKE_ACTIVE: "yes" });
    expect(second.status).toBe(0);
    expect(second.out).toContain("is unchanged");
    expect(second.out).toContain("kept");
    expect(readFileSync(unitPath(), "utf8")).toBe(unitBefore);
    expect(readFileSync(envPath(), "utf8")).toContain("PANEL_PORT=31000");
    expect(calls().some((call) => call.includes("restart") || call.includes(" start "))).toBe(false);
    expect(second.out).toContain("reverse_proxy 127.0.0.1:31000");
  });

  it("keeps the origin already in the environment file, and says so, when a later run names another", () => {
    expect(run().status).toBe(0);
    const result = run({ PANEL_PUBLIC_ORIGIN: "https://other.example" });
    expect(result.status).toBe(0);
    expect(result.out).toContain("already sets PANEL_PUBLIC_ORIGIN=https://example.net");
    const env = readFileSync(envPath(), "utf8");
    expect(env).toContain("PANEL_PUBLIC_ORIGIN=https://example.net");
    expect(env).not.toContain("other.example");
  });

  it("does not warn about the same origin written with a trailing slash, or with quotes", () => {
    expect(run().status).toBe(0);
    writeFileSync(envPath(), readFileSync(envPath(), "utf8").replace("PANEL_PUBLIC_ORIGIN=https://example.net", 'PANEL_PUBLIC_ORIGIN="https://example.net"'));
    const result = run({ PANEL_PUBLIC_ORIGIN: "https://example.net/" });
    expect(result.status).toBe(0);
    expect(result.out).not.toContain("already sets");
  });

  it("stops, and says which line to add, when an existing environment file has no origin line", () => {
    expect(run().status).toBe(0);
    writeFileSync(envPath(), "PANEL_PORT=29200\nPANEL_BASE_PATH=/panel\n");
    const result = run({ PANEL_PUBLIC_ORIGIN: "https://example.net" });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("has no PANEL_PUBLIC_ORIGIN line");
  });

  it("restarts a running panel when its unit changed, and only then", () => {
    expect(run().status).toBe(0);
    rmSync(unitPath());
    writeFileSync(log, "");
    const result = run({ FAKE_ACTIVE: "yes" });
    expect(result.status).toBe(0);
    expect(calls()).toContain("systemctl --user restart jass-panel.service");
  });

  it("does not write outside the configuration and the unit directory", () => {
    expect(run().status).toBe(0);
    const entries = execFileSync("find", [root, "-type", "f"], { encoding: "utf8" }).trim().split("\n");
    for (const entry of entries) {
      const allowed = entry.startsWith(join(home, ".config", "jass-panel")) || entry.startsWith(join(home, ".config", "systemd", "user"));
      expect(allowed || entry.startsWith(join(root, "bin")) || entry === log || entry.startsWith(checkout), entry).toBe(true);
    }
  });
});
