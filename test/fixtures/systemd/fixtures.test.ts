// Contract: the captured `systemctl show` fixtures describe units that were loaded and had run. A unit systemd had already
// dropped from memory answers with defaults (`LoadState=not-found`, no invocation id, `Result=success`, zeros), and
// recording those as exit data would teach a classifier something systemd never said. `static-unit/` is the one deliberate
// exception: a loaded but unreferenced unit that lost its exit data once it ended cleanly.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

function readShow(directory: string, file: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of readFileSync(join(ROOT, directory, file), "utf8").split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) properties.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return properties;
}

function filesIn(directory: string): string[] {
  return readdirSync(join(ROOT, directory)).filter((name) => name.endsWith(".txt"));
}

describe("captured systemctl show fixtures", () => {
  for (const directory of ["matrix", "signals"]) {
    it(`${directory}/ holds only loaded units with a real invocation id`, () => {
      const files = filesIn(directory);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const properties = readShow(directory, file);
        expect(properties.get("LoadState"), `${directory}/${file}`).toBe("loaded");
        expect(properties.get("InvocationID"), `${directory}/${file}`).toMatch(/^[0-9a-f]{32}$/);
      }
    });
  }

  it("an enabled unit keeps its exit status after a clean end, including one accepted by SuccessExitStatus", () => {
    const accepted = readShow("matrix", "no-143-143.txt");
    expect(accepted.get("ActiveState")).toBe("inactive");
    expect(accepted.get("Result")).toBe("success");
    expect(accepted.get("ExecMainStatus")).toBe("143");
    expect(accepted.get("SuccessExitStatus")).toBe("143");
  });

  it("stop-attribution captures come from enabled user-manager units with real invocation ids", () => {
    const files = filesIn("stop-attribution");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const properties = readShow("stop-attribution", file);
      expect(properties.get("LoadState"), file).toBe("loaded");
      expect(properties.get("UnitFileState"), file).toMatch(/^enabled/);
      expect(properties.get("InvocationID"), file).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("an unreferenced unit loses its exit data once it ends cleanly", () => {
    for (const file of filesIn("static-unit")) {
      const properties = readShow("static-unit", file);
      expect(properties.get("ActiveState"), file).toBe("inactive");
      expect(properties.get("InvocationID"), file).toBe("");
      expect(properties.get("ExecMainStatus"), file).toBe("0");
    }
  });
});
