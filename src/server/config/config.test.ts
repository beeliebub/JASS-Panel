import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, isAllowedHost, loadConfig } from "./config.js";

const base = { PANEL_PUBLIC_ORIGIN: "https://example.net" };

describe("loadConfig", () => {
  it("requires PANEL_PUBLIC_ORIGIN and names it in the error", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/PANEL_PUBLIC_ORIGIN is required/);
  });

  it("applies the documented defaults", () => {
    const config = loadConfig({ ...base, HOME: "/home/someone" });
    expect(config.siteOrigin).toBe("http://127.0.0.1:3000");
    expect(config.port).toBe(29200);
    expect(config.basePath).toBe("/panel");
    expect(config.dataDir).toBe(join("/home/someone", ".local", "share", "jass-panel"));
    expect(config.unitDir).toBe(join("/home/someone", ".config", "systemd", "user"));
    expect(config.publicHost).toBe("example.net");
  });

  it("honours the XDG base directories and an explicit data directory", () => {
    const config = loadConfig({ ...base, XDG_DATA_HOME: "/data", XDG_CONFIG_HOME: "/conf", HOME: "/h" });
    expect(config.dataDir).toBe(join("/data", "jass-panel"));
    expect(config.unitDir).toBe(join("/conf", "systemd", "user"));
    expect(loadConfig({ ...base, PANEL_DATA_DIR: "/srv/panel" }).dataDir).toBe("/srv/panel");
  });

  it("derives every data path from the data directory", () => {
    const { paths, dataDir } = loadConfig({ ...base, PANEL_DATA_DIR: "/srv/panel" });
    expect(dataDir).toBe("/srv/panel");
    expect(paths.database).toBe(join("/srv/panel", "panel.db"));
    expect(paths.events).toBe(join("/srv/panel", "events"));
    expect(paths.controlSocket).toBe(join("/srv/panel", "control.sock"));
  });

  it("rejects a relative data directory", () => {
    expect(() => loadConfig({ ...base, PANEL_DATA_DIR: "relative/dir" })).toThrow(/PANEL_DATA_DIR must be an absolute path/);
  });

  it("requires the public origin to be an origin only", () => {
    expect(() => loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net/path" })).toThrow(/origin only/);
    expect(() => loadConfig({ PANEL_PUBLIC_ORIGIN: "ftp://example.net" })).toThrow(/http or https/);
    expect(() => loadConfig({ PANEL_PUBLIC_ORIGIN: "not a url" })).toThrow(/absolute URL/);
    expect(loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net:8443" }).publicHost).toBe("example.net:8443");
  });

  it("refuses a website URL that is not a loopback http origin", () => {
    expect(() => loadConfig({ ...base, SITE_INTERNAL_URL: "https://example.net" })).toThrow(/loopback http/);
    expect(() => loadConfig({ ...base, SITE_INTERNAL_URL: "http://10.0.0.5:3000" })).toThrow(/loopback http/);
    expect(() => loadConfig({ ...base, SITE_INTERNAL_URL: "http://127.0.0.1:3000/api" })).toThrow(/origin only/);
    expect(loadConfig({ ...base, SITE_INTERNAL_URL: "http://localhost:4000" }).siteOrigin).toBe("http://localhost:4000");
  });

  it("validates the port and the base path", () => {
    expect(() => loadConfig({ ...base, PANEL_PORT: "0" })).toThrow(/PANEL_PORT/);
    expect(() => loadConfig({ ...base, PANEL_PORT: "70000" })).toThrow(/PANEL_PORT/);
    expect(() => loadConfig({ ...base, PANEL_PORT: "abc" })).toThrow(/PANEL_PORT/);
    expect(loadConfig({ ...base, PANEL_PORT: "31000" }).port).toBe(31000);
    expect(() => loadConfig({ ...base, PANEL_BASE_PATH: "/" })).toThrow(/PANEL_BASE_PATH/);
    expect(() => loadConfig({ ...base, PANEL_BASE_PATH: "/panel/" })).toThrow(/PANEL_BASE_PATH/);
    expect(() => loadConfig({ ...base, PANEL_BASE_PATH: "panel" })).toThrow(/PANEL_BASE_PATH/);
    expect(loadConfig({ ...base, PANEL_BASE_PATH: "/tools/panel" }).basePath).toBe("/tools/panel");
  });
});

describe("isAllowedHost", () => {
  const config = loadConfig(base, { uid: 1000 });

  it("accepts the public host and loopback on any port", () => {
    expect(isAllowedHost("example.net", config)).toBe(true);
    expect(isAllowedHost("EXAMPLE.net", config)).toBe(true);
    expect(isAllowedHost("127.0.0.1:29200", config)).toBe(true);
    expect(isAllowedHost("localhost:5173", config)).toBe(true);
    expect(isAllowedHost("[::1]:29200", config)).toBe(true);
  });

  it("refuses any other host, a missing host and look-alikes", () => {
    expect(isAllowedHost(undefined, config)).toBe(false);
    expect(isAllowedHost("", config)).toBe(false);
    expect(isAllowedHost("evil.example", config)).toBe(false);
    expect(isAllowedHost("example.net.evil.example", config)).toBe(false);
    expect(isAllowedHost("127.0.0.1.evil.example", config)).toBe(false);
  });
});
