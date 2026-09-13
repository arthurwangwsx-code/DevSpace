import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  shutdownHttpServer,
  waitForHttpServerListening,
} from "./server-shutdown.js";

let finishHttpClose: (() => void) | undefined;
let applicationCloseStarted = false;

const drainingHttpServer = {
  close(callback: (error?: Error) => void) {
    finishHttpClose = () => callback();
  },
};

const drainingShutdown = shutdownHttpServer(drainingHttpServer, async () => {
  applicationCloseStarted = true;
  assert.ok(
    finishHttpClose,
    "HTTP draining must start before application cleanup",
  );
  finishHttpClose();
});

await Promise.resolve();
assert.equal(
  applicationCloseStarted,
  true,
  "application cleanup must start while the HTTP server is draining",
);
await drainingShutdown;

let finishApplicationClose: (() => void) | undefined;
let shutdownResolved = false;

const immediatelyClosedHttpServer = {
  close(callback: (error?: Error) => void) {
    callback();
  },
};

const delayedApplicationClose = () =>
  new Promise<void>((resolve) => {
    finishApplicationClose = resolve;
  });

const delayedShutdown = shutdownHttpServer(
  immediatelyClosedHttpServer,
  delayedApplicationClose,
);
void delayedShutdown.then(() => {
  shutdownResolved = true;
});

await Promise.resolve();
assert.equal(
  shutdownResolved,
  false,
  "shutdown must wait for asynchronous application cleanup",
);
finishApplicationClose?.();
await delayedShutdown;
assert.equal(shutdownResolved, true);

let finishDelayedHttpClose: (() => void) | undefined;
let httpDrainResolved = false;
const delayedHttpDrain = shutdownHttpServer(
  {
    close(callback: (error?: Error) => void) {
      finishDelayedHttpClose = () => callback();
    },
  },
  async () => {},
);
void delayedHttpDrain.then(() => {
  httpDrainResolved = true;
});

await Promise.resolve();
assert.equal(
  httpDrainResolved,
  false,
  "shutdown must wait for active HTTP responses to drain",
);
finishDelayedHttpClose?.();
await delayedHttpDrain;
assert.equal(httpDrainResolved, true);

const httpCloseError = new Error("http close failed");
await assert.rejects(
  shutdownHttpServer(
    {
      close(callback: (error?: Error) => void) {
        callback(httpCloseError);
      },
    },
    async () => {},
  ),
  httpCloseError,
);

let cleanupAfterUnstarted = false;
const notRunningError = Object.assign(new Error("Server is not running."), {
  code: "ERR_SERVER_NOT_RUNNING",
});
await shutdownHttpServer(
  { close(callback) { callback(notRunningError); } },
  async () => { cleanupAfterUnstarted = true; },
);
assert.equal(cleanupAfterUnstarted, true);

const occupied = createServer();
occupied.listen(0, "127.0.0.1");
await waitForHttpServerListening(occupied);
const address = occupied.address();
assert.ok(address && typeof address === "object");
const conflicting = createServer();
conflicting.listen(address.port, "127.0.0.1");
await assert.rejects(
  waitForHttpServerListening(conflicting),
  (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE"),
);
await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));

console.log("server shutdown tests passed: drain, cleanup, unstarted close, startup conflict");
