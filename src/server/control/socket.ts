// The control socket: one line in, one line out, for the update request only. It lives in the data directory with mode 0600, so only
// the account that runs the panel can reach it. Each connection gets a short deadline, and a line longer than a few hundred bytes is
// refused without being read further.
import { chmodSync, existsSync, lstatSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

const MAX_LINE = 256;
const DEADLINE_MS = 120_000;

export interface ControlSocket {
  close(): Promise<void>;
}

/** The kernel's limit on a Unix socket path, including the terminating byte. A longer path cannot be bound at all. */
const UNIX_PATH_LIMIT = 108;

export class ControlSocketError extends Error {}

export async function startControlSocket(path: string, handle: (line: string) => Promise<string>): Promise<ControlSocket> {
  if (Buffer.byteLength(path, "utf8") >= UNIX_PATH_LIMIT) {
    throw new ControlSocketError(`the control socket path is ${Buffer.byteLength(path, "utf8")} bytes; a Unix socket path may be at most ${UNIX_PATH_LIMIT - 1}. Choose a shorter PANEL_DATA_DIR.`);
  }
  if (existsSync(path)) {
    // Only a stale socket left by an earlier daemon is replaced; anything else at that path is an error.
    if (!lstatSync(path).isSocket()) throw new Error("the control socket path is taken by something that is not a socket");
    rmSync(path, { force: true });
  }
  const server: Server = createServer((socket: Socket) => {
    socket.setTimeout(DEADLINE_MS, () => socket.destroy());
    let buffered = "";
    let answered = false;
    socket.on("data", (chunk: Buffer) => {
      if (answered) return;
      buffered += chunk.toString("utf8");
      if (buffered.length > MAX_LINE) {
        answered = true;
        socket.end("refused: the request is too long\n");
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      answered = true;
      const line = buffered.slice(0, newline).trim();
      void handle(line).then(
        (reply) => socket.end(`${reply}\n`),
        () => socket.end("failed: the request could not be handled\n"),
      );
    });
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      chmodSync(path, 0o600);
      resolve();
    });
  });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(path, { force: true });
          resolve();
        });
      }),
  };
}
