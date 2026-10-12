import { describe, expect, it } from "vitest";
import { LOCK_FAILURES, LOCK_MS, PasswordLockout } from "./lockout.js";
import { catalogue, findAction, JAVA_PACKAGES } from "./catalogue.js";
import { scrubOutput } from "./run.js";

describe("PasswordLockout", () => {
  it("locks on the second consecutive wrong password, for fifteen minutes, and clears on a correct one", () => {
    let at = 0;
    const lock = new PasswordLockout(() => at);
    expect(LOCK_FAILURES).toBe(2);
    expect(lock.record(false)).toBe(false);
    expect(lock.record(false)).toBe(true);
    expect(lock.remaining()).toBe(LOCK_MS);
    at += LOCK_MS;
    expect(lock.remaining()).toBe(0);
  });

  it("a correct password clears the count", () => {
    const lock = new PasswordLockout(() => 0);
    lock.record(false);
    lock.record(true);
    expect(lock.record(false)).toBe(false);
    expect(lock.remaining()).toBe(0);
  });
});

describe("catalogue", () => {
  it("builds enable-lingering for the account it is given and nothing else", () => {
    const action = findAction("enable-lingering", catalogue({ account: "someone" }));
    expect(action?.argv).toEqual(["loginctl", "enable-linger", "someone"]);
    expect(findAction("install-java", catalogue({ account: "someone" }))).toBeUndefined();
  });

  it("adds install-java only for a package on the allowlist, passed after --", () => {
    const pkg = JAVA_PACKAGES[0] ?? "";
    const action = findAction("install-java", catalogue({ account: "x", javaPackage: pkg }));
    expect(action?.argv).toEqual(["apt-get", "install", "-y", "--", pkg]);
    expect(() => catalogue({ account: "x", javaPackage: "not-listed" })).toThrow(RangeError);
  });
});

describe("scrubOutput", () => {
  it("removes the password and cuts long output", () => {
    expect(scrubOutput("a secret-word b", "secret-word")).toBe("a [removed] b");
    expect(scrubOutput("x".repeat(5000), "").endsWith("[output truncated]")).toBe(true);
  });
});
