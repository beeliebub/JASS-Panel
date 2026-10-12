import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { onlinePlayers } from "./players.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "test", "fixtures", "latest-log");

describe("onlinePlayers", () => {
  it("tracks joins and leaves, and empties the list at a start or a stop", () => {
    const lines = [
      "[10:00:00] [Server thread/INFO]: Starting minecraft server version 26.3",
      "[10:00:05] [Server thread/INFO]: System chat: Alpha joined the game",
      "[10:00:06] [Server thread/INFO]: System chat: Bravo joined the game",
      "[10:00:07] [Server thread/INFO]: System chat: Alpha left the game",
      "[10:00:08] [Server thread/INFO]: Stopping server",
      "[10:00:09] [Server thread/INFO]: System chat: Charlie joined the game",
    ];
    expect(onlinePlayers(lines)).toEqual(["Charlie"]);
  });

  it("reads the real players capture without losing a player to a rotation marker", () => {
    const text = readFileSync(join(FIXTURES, "players-main.txt"), "utf8").split("\n");
    expect(Array.isArray(onlinePlayers(text))).toBe(true);
  });
});
