import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderServiceUnit, renderSocketUnit, STOP_EVENT_SCRIPT, UnitRenderError, unitArgument } from "./unit.js";

const DATA = "/srv/panel-data";
const base = { id: "alpha", directory: "/srv/servers/alpha", startCommand: ["/usr/bin/java", "-jar", "paper.jar", "nogui"] };

describe("renderServiceUnit", () => {
  it("renders the directives the design requires, and nothing that would restart a stopped server", () => {
    const unit = renderServiceUnit(base, DATA);
    expect(unit).toContain("Type=simple");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).not.toMatch(/Restart=always/);
    expect(unit).toContain("SuccessExitStatus=143");
    expect(unit).toContain("Sockets=jass-mc-alpha.socket");
    expect(unit).toContain("StandardInput=socket");
    expect(unit).toContain("Requires=jass-mc-alpha.socket");
    expect(unit).toContain("StartLimitIntervalSec=300");
    expect(unit).toContain("StartLimitBurst=5");
    expect(unit).toContain("TimeoutStartSec=300");
    expect(unit).toContain("TimeoutStopSec=120");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("WorkingDirectory=/srv/servers/alpha");
  });

  it("quotes every ExecStart argument and passes nothing through a shell", () => {
    const unit = renderServiceUnit(base, DATA);
    expect(unit).toContain('ExecStart="/usr/bin/java" "-jar" "paper.jar" "nogui"');
  });

  it("runs the stop-event script with the id as its only argument, prefixed so a failure cannot fail the unit", () => {
    const unit = renderServiceUnit(base, DATA);
    expect(unit).toContain(`ExecStopPost=-"${DATA}/bin/stop-event" "alpha"`);
  });

  it("puts only the id in the description, never a display name", () => {
    const unit = renderServiceUnit(base, DATA);
    expect(unit).toContain("Description=Minecraft server alpha (managed by JASS Panel)");
  });

  it("refuses a program that is not an absolute path", () => {
    expect(() => renderServiceUnit({ ...base, startCommand: ["java", "-jar", "x.jar"] }, DATA)).toThrow(UnitRenderError);
    expect(() => renderServiceUnit({ ...base, startCommand: [] }, DATA)).toThrow(UnitRenderError);
  });

  it("refuses an id that is not a slug, including ones that would read as options or paths", () => {
    for (const id of ["-dash", "UPPER", "a/b", "a..b", "a b", "", "x".repeat(33), "*"]) {
      expect(() => renderServiceUnit({ ...base, id }, DATA), id).toThrow(UnitRenderError);
    }
  });

  it("accepts the reserved-looking id constructor, which the lookups must handle with a Map", () => {
    expect(renderServiceUnit({ ...base, id: "constructor" }, DATA)).toContain("jass-mc-constructor.socket");
  });

  it("refuses a NUL or a line break in any value, so a value cannot add a directive", () => {
    const hostile = [
      { ...base, directory: "/srv/a\nExecStartPost=/bin/rm" },
      { ...base, directory: "/srv/a\u0000b" },
      { ...base, startCommand: ["/usr/bin/java", "-Dx=1\nRestart=always"] },
      { ...base, startCommand: ["/usr/bin/java", "a\rb"] },
    ];
    for (const server of hostile) {
      expect(() => renderServiceUnit(server, DATA)).toThrow(UnitRenderError);
    }
  });

  it("doubles % and $ so systemd does not expand them, in arguments and in plain values", () => {
    expect(unitArgument("100%$HOME")).toBe('"100%%$$HOME"');
    const unit = renderServiceUnit({ ...base, directory: "/srv/a%b$c", startCommand: ["/usr/bin/java", "%n", "$PATH"] }, DATA);
    expect(unit).toContain("WorkingDirectory=/srv/a%%b$$c");
    expect(unit).toContain('"%%n" "$$PATH"');
  });

  it("escapes backslashes and quotes inside an argument", () => {
    expect(unitArgument('say "hi" \\ there')).toBe('"say \\"hi\\" \\\\ there"');
  });

  it("keeps spaces inside one argument as one argument", () => {
    expect(renderServiceUnit({ ...base, startCommand: ["/usr/bin/java", "a b"] }, DATA)).toContain('"/usr/bin/java" "a b"');
  });
});

describe("a value that would continue its line", () => {
  it("refuses a directory whose last character is a backslash", () => {
    expect(() => renderServiceUnit({ ...base, directory: "/srv/mc\\" }, DATA)).toThrow(UnitRenderError);
    expect(renderServiceUnit({ ...base, directory: "/srv/mc\\x" }, DATA)).toContain("WorkingDirectory=/srv/mc\\x");
  });
});

describe("renderSocketUnit", () => {
  it("places the FIFO in the runtime directory and binds the socket to the service with PartOf", () => {
    const socket = renderSocketUnit("alpha");
    expect(socket).toContain("PartOf=jass-mc-alpha.service");
    expect(socket).toContain("ListenFIFO=%t/jass-mc-alpha.stdin");
    expect(socket).toContain("SocketMode=0600");
    expect(socket).toContain("RemoveOnStop=true");
  });

  it("refuses an invalid id", () => {
    expect(() => renderSocketUnit("../escape")).toThrow(UnitRenderError);
  });
});

describe("STOP_EVENT_SCRIPT", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jass-panel-stop-"));
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "events"));
    writeFileSync(join(root, "bin", "stop-event"), STOP_EVENT_SCRIPT);
    chmodSync(join(root, "bin", "stop-event"), 0o700);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function stop(id: string, env: Record<string, string>) {
    return spawnSync("/bin/sh", [join(root, "bin", "stop-event"), id], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", ...env },
    });
  }

  it("appends the result, code and status systemd provides, and exits 0", () => {
    const result = stop("alpha", { SERVICE_RESULT: "success", EXIT_CODE: "exited", EXIT_STATUS: "143" });
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "events", "alpha.log"), "utf8")).toBe("result=success code=exited status=143\n");
  });

  it("writes nothing and still exits 0 for an id that is not a slug", () => {
    for (const id of ["../escape", "-x", "", "a b"]) {
      const result = stop(id, { SERVICE_RESULT: "signal", EXIT_CODE: "killed", EXIT_STATUS: "KILL" });
      expect(result.status, id).toBe(0);
    }
    expect(existsSync(join(root, "escape.log"))).toBe(false);
    expect(execFileSync("ls", [join(root, "events")], { encoding: "utf8" })).toBe("");
  });
});

describe("systemd-analyze", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jass-panel-verify-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a rendered service and socket for hostile names and directories", () => {
    const probe = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) return;
    const server = { id: "jass-test-verify", directory: `${dir}/a b%c$d`, startCommand: ["/bin/true", "a \"b\" c%d"] };
    writeFileSync(join(dir, "jass-mc-jass-test-verify.service"), renderServiceUnit(server, dir));
    writeFileSync(join(dir, "jass-mc-jass-test-verify.socket"), renderSocketUnit("jass-test-verify"));
    const verify = spawnSync("systemd-analyze", ["--user", "verify", join(dir, "jass-mc-jass-test-verify.service"), join(dir, "jass-mc-jass-test-verify.socket")], {
      encoding: "utf8",
    });
    const output = `${verify.stdout}${verify.stderr}`;
    expect(output).not.toContain("jass-mc-jass-test-verify");
  });
});
