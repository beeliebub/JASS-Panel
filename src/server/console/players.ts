// The online list, worked out from join and leave lines since the server last started. It is approximate: a rotated log or a panel
// restart mid-session loses lines, so nothing automatic depends on it. A start line or a stop line empties the list.
import { classify } from "./classify.js";

const SESSION_START = /^Starting minecraft server version /;
const SESSION_END = /^Stopping server$/;

export function onlinePlayers(texts: readonly string[]): string[] {
  const online = new Set<string>();
  for (const text of texts) {
    const parsed = classify(text);
    if (SESSION_START.test(parsed.text) || SESSION_END.test(parsed.text)) {
      online.clear();
      continue;
    }
    if (parsed.kind === "join" && parsed.player !== null) online.add(parsed.player);
    if (parsed.kind === "leave" && parsed.player !== null) online.delete(parsed.player);
  }
  return [...online].sort();
}
