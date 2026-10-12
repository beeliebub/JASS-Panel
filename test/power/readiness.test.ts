// The start-up readiness check. A server is loaded only when the journal of its current run has its Done line. The answer is remembered
// for that run, and a run that has not printed Done is looked at again each time. Nothing here starts a unit: the runner is a stand-in.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DONE_LINE, loadedMarkerOf, Readiness } from "../../src/server/power/readiness.js";
import type { Runner, RunResult } from "../../src/server/systemd/run.js";
import type { ObservedState } from "../../src/server/systemd/user.js";

const INVOCATION = "0123456789abcdef0123456789abcdef";
const NEXT_INVOCATION = "fedcba9876543210fedcba9876543210";
// The journal copy of the line, as captured from a real Paper 26.3 run: no thread name.
const DONE_JOURNAL = '[08:29:21 INFO]: Done (11.756s)! For help, type "help"';

function unitState(activeState: string, invocationId: string | null = INVOCATION): ObservedState {
  return {
    known: true,
    state: { activeState, subState: "running", result: "success", execMainStatus: null, nRestarts: 0, mainPid: 1, activeSince: "x", memoryBytes: null, invocationId, loaded: false },
  };
}

/** A journal stand-in: every call is recorded, and each answers with the output the test gives it. */
function journal(answers: (() => RunResult)[]): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = (argv): Promise<RunResult> => {
    calls.push(argv.join(" "));
    const answer = answers[calls.length - 1] ?? answers[answers.length - 1];
    return Promise.resolve((answer ?? (() => ({ code: 0, signal: null, stdout: "", stderr: "" })))());
  };
  return { run, calls };
}

const printed = (stdout: string) => () => ({ code: 0, signal: null, stdout, stderr: "" });

describe("the Done line", () => {
  it("matches the line Paper prints on the console and the journal's copy of it", () => {
    expect(DONE_LINE.test('[17:00:30] [Server thread/INFO]: Done (17.545s)! For help, type "help"')).toBe(true);
    expect(DONE_LINE.test(DONE_JOURNAL)).toBe(true);
    expect(DONE_LINE.test('[17:00:30 INFO]: Done (17.5s) with the help line missing')).toBe(false);
  });

  it("does not count a chat line that repeats the words, because a chat line carries a player's name before its text", () => {
    expect(DONE_LINE.test('[17:00:30 INFO]: <Steve> Done (1.0s)! For help, type "help"')).toBe(false);
  });

  it("matches the line in the fixture captured from a real Paper start", () => {
    const fixture = readFileSync(fileURLToPath(new URL("../fixtures/latest-log/startup-main.txt", import.meta.url)), "utf8");
    expect(fixture.split("\n").some((line) => DONE_LINE.test(line))).toBe(true);
  });
});

describe("whether a unit's current run has loaded", () => {
  it("is loaded for an active run whose journal has its Done line, read for that invocation only", async () => {
    const { run, calls } = journal([printed(`${DONE_JOURNAL}\n`)]);
    const states = await new Readiness().annotate(run, new Map([["alpha", unitState("active")]]));
    expect(states.get("alpha")).toMatchObject({ known: true, state: { loaded: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`_SYSTEMD_INVOCATION_ID=${INVOCATION}`);
    expect(calls[0]).toContain("-u jass-mc-alpha.service");
    expect(calls[0]).toContain("--grep=Done \\(");
  });

  it("is not loaded while the journal has no Done line", async () => {
    const { run } = journal([printed("")]);
    const states = await new Readiness().annotate(run, new Map([["alpha", unitState("active")]]));
    expect(states.get("alpha")).toMatchObject({ known: true, state: { loaded: false } });
  });

  it("counts a server that was not made from the Paper preset as loaded while its unit is active, and does not ask the journal", async () => {
    const { run, calls } = journal([printed("")]);
    const states = await new Readiness({ paperServer: () => false }).annotate(run, new Map([["alpha", unitState("active")]]));
    expect(states.get("alpha")).toMatchObject({ known: true, state: { loaded: true } });
    expect(calls).toEqual([]);
  });

  it("is not loaded when the journal cannot be read, which keeps the console refused", async () => {
    const { run } = journal([() => ({ code: 1, signal: null, stdout: DONE_JOURNAL, stderr: "no journal" })]);
    const states = await new Readiness().annotate(run, new Map([["alpha", unitState("active")]]));
    expect(states.get("alpha")).toMatchObject({ known: true, state: { loaded: false } });
  });

  it("is never loaded for a unit that is not active, and the journal is not asked", async () => {
    const { run, calls } = journal([printed(`${DONE_JOURNAL}\n`)]);
    const states = await new Readiness().annotate(run, new Map([["alpha", unitState("inactive")]]));
    expect(states.get("alpha")).toMatchObject({ known: true, state: { loaded: false } });
    expect(calls).toEqual([]);
  });

  it("is not loaded when systemd gave no invocation id to match the journal against", async () => {
    const { run, calls } = journal([printed(`${DONE_JOURNAL}\n`)]);
    const states = await new Readiness().annotate(run, new Map([["alpha", unitState("active", null)]]));
    expect(states.get("alpha")).toMatchObject({ known: true, state: { loaded: false } });
    expect(calls).toEqual([]);
  });

  it("keeps a unit that is not known to systemd unknown, rather than loaded", async () => {
    const { run } = journal([]);
    const unknown: ObservedState = { known: false, reason: "the unit is not known to systemd" };
    const states = await new Readiness().annotate(run, new Map([["alpha", unknown]]));
    expect(states.get("alpha")).toEqual(unknown);
  });

  it("remembers a loaded run without asking the journal again, and looks at a new run afresh", async () => {
    const readiness = new Readiness();
    const { run, calls } = journal([printed(`${DONE_JOURNAL}\n`), printed("")]);
    await readiness.annotate(run, new Map([["alpha", unitState("active")]]));
    const again = await readiness.annotate(run, new Map([["alpha", unitState("active")]]));
    expect(again.get("alpha")).toMatchObject({ known: true, state: { loaded: true } });
    expect(calls).toHaveLength(1);

    const next = await readiness.annotate(run, new Map([["alpha", unitState("active", NEXT_INVOCATION)]]));
    expect(next.get("alpha")).toMatchObject({ known: true, state: { loaded: false } });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(`_SYSTEMD_INVOCATION_ID=${NEXT_INVOCATION}`);
  });
});

describe("the loaded marker", () => {
  it("lets a restarted daemon see a run that loaded before the restart, without asking the journal again", async () => {
    const markers = mkdtempSync(join(tmpdir(), "jass-panel-markers-"));
    try {
      const before = journal([printed(`${DONE_JOURNAL}\n`)]);
      await new Readiness({ markers }).annotate(before.run, new Map([["alpha", unitState("active")]]));
      expect(readFileSync(loadedMarkerOf(markers, "alpha"), "utf8").trim()).toBe(INVOCATION);

      const after = journal([printed("")]);
      const states = await new Readiness({ markers }).annotate(after.run, new Map([["alpha", unitState("active")]]));
      expect(states.get("alpha")).toMatchObject({ known: true, state: { loaded: true } });
      expect(after.calls).toEqual([]);
    } finally {
      rmSync(markers, { recursive: true, force: true });
    }
  });

  it("does not trust a marker that names another run, and asks the journal about the run it finds", async () => {
    const markers = mkdtempSync(join(tmpdir(), "jass-panel-markers-"));
    try {
      writeFileSync(loadedMarkerOf(markers, "alpha"), `${INVOCATION}\n`);
      const journalAnswer = journal([printed("")]);
      const states = await new Readiness({ markers }).annotate(journalAnswer.run, new Map([["alpha", unitState("active", NEXT_INVOCATION)]]));
      expect(states.get("alpha")).toMatchObject({ known: true, state: { loaded: false } });
      expect(journalAnswer.calls).toHaveLength(1);
      expect(journalAnswer.calls[0]).toContain(`_SYSTEMD_INVOCATION_ID=${NEXT_INVOCATION}`);
    } finally {
      rmSync(markers, { recursive: true, force: true });
    }
  });
});
