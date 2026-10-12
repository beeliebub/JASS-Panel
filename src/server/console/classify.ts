// Classifies one line of latest.log by its shape. The patterns are pinned to captured output in test/fixtures/latest-log: a
// server's own wording is not something the panel can change, so each rule states what the line looks like on a real Paper run.
export type LineKind = "chat" | "join" | "leave" | "death" | "advancement" | "warning" | "error" | "crash" | "system" | "other";

export interface ParsedLine {
  readonly kind: LineKind;
  readonly time: string | null;
  readonly thread: string | null;
  readonly level: string | null;
  readonly text: string;
  readonly player: string | null;
}

const PREFIX = /^\[(\d{2}:\d{2}:\d{2})\] \[([^\]]+?)\/(INFO|WARN|ERROR|FATAL|DEBUG|TRACE)\]: (.*)$/;
const SYSTEM_CHAT = /^System chat: (.*)$/;
const JOIN = /^([A-Za-z0-9_]{3,16}) joined the game$/;
const LEAVE = /^([A-Za-z0-9_]{3,16}) left the game$/;
const CHAT = /^<([A-Za-z0-9_]{3,16})> /;
const SAY = /^\[Not Secure\] \[Server\] /;
const ADVANCEMENT = /^([A-Za-z0-9_]{3,16}) has (made the advancement|completed the challenge|reached the goal)/;
const DEATH = /^([A-Za-z0-9_]{3,16}) (was |fell |died|drowned|burned|blew up|starved|suffocated|hit the ground|withered|tried to swim|went up in flames|froze|discovered the floor|experienced kinetic|walked into|was pricked|was impaled|was squashed|was struck|was killed|was slain|was shot)/;
const CRASH = /crash report|Preparing crash report/i;

export function classify(line: string): ParsedLine {
  const prefixed = PREFIX.exec(line);
  const time = prefixed?.[1] ?? null;
  const thread = prefixed?.[2] ?? null;
  const level = prefixed?.[3] ?? null;
  const text = prefixed?.[4] ?? line;
  const plain = (kind: LineKind, player: string | null = null): ParsedLine => ({ kind, time, thread, level, text, player });

  const system = SYSTEM_CHAT.exec(text);
  const body = system?.[1] ?? text;
  const join = JOIN.exec(body);
  if (join !== null) return plain("join", join[1] ?? null);
  const leave = LEAVE.exec(body);
  if (leave !== null) return plain("leave", leave[1] ?? null);
  if (CRASH.test(text) && (level === "ERROR" || level === "FATAL" || level === null)) return plain("crash");
  const chat = CHAT.exec(text);
  if (chat !== null) return plain("chat", chat[1] ?? null);
  if (SAY.test(text)) return plain("chat", null);
  const advancement = ADVANCEMENT.exec(text);
  if (advancement !== null) return plain("advancement", advancement[1] ?? null);
  const death = DEATH.exec(text);
  if (death !== null) return plain("death", death[1] ?? null);
  if (level === "ERROR" || level === "FATAL") return plain("error");
  if (level === "WARN") return plain("warning");
  if (system !== null) return plain("system");
  return plain("other");
}
