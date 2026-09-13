export interface ClosableHttpServer {
  close(callback: (error?: Error) => void): void;
}

export interface StartingHttpServer {
  readonly listening: boolean;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "listening", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  off(event: "listening", listener: () => void): unknown;
}

export function waitForHttpServerListening(
  httpServer: StartingHttpServer,
): Promise<void> {
  if (httpServer.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      httpServer.off("error", onError);
      httpServer.off("listening", onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
  });
}

export async function shutdownHttpServer(
  httpServer: ClosableHttpServer,
  closeApplication: () => Promise<void>,
): Promise<void> {
  const httpClosed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (isServerNotRunning(error)) resolve();
      else if (error) reject(error);
      else resolve();
    });
  });

  await closeApplication();
  await httpClosed;
}

function isServerNotRunning(error: Error | undefined): boolean {
  return Boolean(error && "code" in error && error.code === "ERR_SERVER_NOT_RUNNING");
}
