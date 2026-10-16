import { createServer } from "node:http";

import { WebSocket, WebSocketServer } from "ws";
import { expect, it, onTestFinished, vi } from "vitest";

import { CdpTargetSessionOwner } from "../../../src/browser/CdpTargetSessionOwner.js";
import { CdpConnection } from "../../../src/browser/CdpConnection.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

it("waits for a late owned handshake and does not close its active peer on retry", async () => {
  const http = createServer();
  const webSockets = new WebSocketServer({ noServer: true });
  let port = 0;
  let releaseUpgrade: (() => void) | undefined;
  let upgradeReceived: (() => void) | undefined;
  const received = new Promise<void>((resolve) => {
    upgradeReceived = resolve;
  });
  const allow = new Promise<void>((resolve) => {
    releaseUpgrade = resolve;
  });
  http.on("upgrade", (request, socket, head) => {
    upgradeReceived?.();
    void allow.then(() =>
      webSockets.handleUpgrade(request, socket, head, (webSocket) =>
        webSockets.emit("connection", webSocket, request),
      ),
    );
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string")
    throw new Error("Fixture did not bind a TCP port");
  port = address.port;
  const owner = new CdpTargetSessionOwner();
  let connecting: Promise<CdpConnection> | undefined;
  onTestFinished(async () => {
    releaseUpgrade?.();
    if (connecting !== undefined) {
      const pendingConnection = await connecting;
      await owner.finish(pendingConnection);
    }
    await owner.close();
    await new Promise<void>((resolve, reject) =>
      webSockets.close((cause) => (cause ? reject(cause) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      http.close((cause) => (cause ? reject(cause) : resolve())),
    );
  });

  connecting = owner.connect(
    `ws://127.0.0.1:${String(port)}/devtools/browser/late`,
    "inspect_web_page",
    {},
    "late-handshake",
  );
  await received;
  const closing = owner.close();
  releaseUpgrade?.();
  const connection = await connecting;
  await owner.finish(connection);
  await closing;
  expect(connection).toBeDefined();
});

it("retries only the failed transport and does not repeat successful child cleanup", async () => {
  const browser = await startFakeCdpBrowser();
  const owner = new CdpTargetSessionOwner();
  let active: CdpConnection | undefined;
  onTestFinished(async () => {
    if (active !== undefined) await owner.finish(active);
    await owner.close();
    await browser.close();
  });
  const failed = await owner.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
    {},
    "failed-session",
  );
  active = await owner.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
    {},
    "active-peer",
  );
  const close = vi
    .spyOn(WebSocket.prototype, "close")
    .mockImplementationOnce(() => {
      throw new Error("controlled close failure");
    });
  const terminate = vi
    .spyOn(WebSocket.prototype, "terminate")
    .mockImplementation(() => undefined);
  try {
    const failure = await owner.finish(failed).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ProviderCleanupError);
    expect(failure).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["failed-session"],
    });
  } finally {
    close.mockRestore();
    terminate.mockRestore();
  }

  await owner.retryPending();
  await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(1));
  const cleanup = vi.fn(async () => undefined);
  await owner.finish(active, cleanup);
  await owner.retryPending();
  await owner.close();
  expect(cleanup).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  expect(browser.commands.map(({ method }) => method)).not.toContain(
    "Target.closeTarget",
  );
  expect(browser.commands.map(({ method }) => method)).not.toContain(
    "Browser.close",
  );
});

it("accepts asynchronous terminate success only after the close event", async () => {
  const browser = await startFakeCdpBrowser();
  const owner = new CdpTargetSessionOwner();
  onTestFinished(async () => {
    await owner.close();
    await browser.close();
  });
  const connection = await owner.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
    {},
    "forced-close",
  );
  const originalTerminate = WebSocket.prototype.terminate;
  const close = vi
    .spyOn(WebSocket.prototype, "close")
    .mockImplementation(() => undefined);
  const terminate = vi
    .spyOn(WebSocket.prototype, "terminate")
    .mockImplementation(function (this: WebSocket) {
      return originalTerminate.call(this);
    });
  try {
    await owner.finish(connection);
  } finally {
    close.mockRestore();
    terminate.mockRestore();
  }
  await owner.close();
  await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
});

it("clears returned inspection and shutdown cleanup status only after socket release", async () => {
  const browser = await startFakeCdpBrowser();
  const provider = new CdpBrowserProvider();
  const originalClose = CdpConnection.prototype.close;
  let denied = true;
  const closing = vi
    .spyOn(CdpConnection.prototype, "close")
    .mockImplementation(function (this: CdpConnection) {
      return denied
        ? Promise.reject(new Error("controlled transport close failure"))
        : originalClose.call(this);
    });
  onTestFinished(async () => {
    closing.mockRestore();
    await provider.close();
    await browser.close();
  });
  const result = await provider.inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    }),
  );
  if (result.ok) throw new Error("Expected retained socket cleanup failure");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.partialObservation).toBeDefined();
  const observation = result.error.partialObservation;
  const retry = await provider.close().catch((cause: unknown) => cause);
  expect(retry).toBeInstanceOf(AnalysisError);
  if (!(retry instanceof AnalysisError))
    throw new Error("Missing retry failure");
  expect(retry.cleanupIncomplete).toBe(true);
  expect(browser.activeConnectionCount()).toBe(1);
  denied = false;
  await provider.close();
  await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  expect(result.error.cleanupIncomplete).toBe(false);
  expect(retry.cleanupIncomplete).toBe(false);
  expect(result.error.partialObservation).toBe(observation);
  expect(browser.commands.map(({ method }) => method)).not.toContain(
    "Browser.close",
  );
  expect(browser.commands.map(({ method }) => method)).not.toContain(
    "Target.closeTarget",
  );
});

it("retains cleanupIncomplete for unresolved socket while resolving released socket in mixed outcome", async () => {
  const browser = await startFakeCdpBrowser();
  const owner = new CdpTargetSessionOwner();
  const originalClose = CdpConnection.prototype.close;
  const deniedSockets = new Set<CdpConnection>();

  const closing = vi
    .spyOn(CdpConnection.prototype, "close")
    .mockImplementation(function (this: CdpConnection) {
      return deniedSockets.has(this)
        ? Promise.reject(new Error("controlled transport close failure"))
        : originalClose.call(this);
    });

  onTestFinished(async () => {
    closing.mockRestore();
    await owner.close().catch(() => undefined);
    await browser.close();
  });

  const c1 = await owner.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
    {},
    "socket-1",
  );
  const c2 = await owner.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
    {},
    "socket-2",
  );

  deniedSockets.add(c1);
  deniedSockets.add(c2);

  const err1 = await owner.finish(c1).catch((cause: unknown) => cause);
  const err2 = await owner.finish(c2).catch((cause: unknown) => cause);

  expect(err1).toBeInstanceOf(AnalysisError);
  expect(err2).toBeInstanceOf(AnalysisError);
  expect((err1 as AnalysisError).cleanupIncomplete).toBe(true);
  expect((err2 as AnalysisError).cleanupIncomplete).toBe(true);

  // Both fail on initial retry, producing an aggregate error
  const retryAll = await owner.close().catch((cause: unknown) => cause);
  expect(retryAll).toBeInstanceOf(AnalysisError);
  expect((retryAll as AnalysisError).cleanupIncomplete).toBe(true);

  // Allow socket 1 to release, but keep socket 2 failing
  deniedSockets.delete(c1);
  const retry2 = await owner.close().catch((cause: unknown) => cause);
  expect(retry2).toBeInstanceOf(AnalysisError);
  expect((retry2 as AnalysisError).cleanupIncomplete).toBe(true);

  // Socket 1 is released, so err1 must now be resolved (cleanupIncomplete === false)
  expect((err1 as AnalysisError).cleanupIncomplete).toBe(false);

  // Socket 2 is still failing, so err2, retryAll, and retry2 must remain cleanupIncomplete === true
  expect((err2 as AnalysisError).cleanupIncomplete).toBe(true);
  expect((retryAll as AnalysisError).cleanupIncomplete).toBe(true);
  expect((retry2 as AnalysisError).cleanupIncomplete).toBe(true);

  // Now allow socket 2 to release
  deniedSockets.delete(c2);
  await owner.close();

  // All errors covering socket 2 and the aggregate must now be resolved
  expect((err2 as AnalysisError).cleanupIncomplete).toBe(false);
  expect((retryAll as AnalysisError).cleanupIncomplete).toBe(false);
  expect((retry2 as AnalysisError).cleanupIncomplete).toBe(false);
});

it("preserves primary analysis failure when cleanup failure resolves after socket release", async () => {
  const browser = await startFakeCdpBrowser({
    commandError: (command) =>
      command.method === "Runtime.enable"
        ? { code: -32000, message: "controlled primary failure" }
        : undefined,
  });
  const provider = new CdpBrowserProvider();
  const originalClose = CdpConnection.prototype.close;
  let denied = true;
  const closing = vi
    .spyOn(CdpConnection.prototype, "close")
    .mockImplementation(function (this: CdpConnection) {
      return denied
        ? Promise.reject(new Error("controlled transport close failure"))
        : originalClose.call(this);
    });
  onTestFinished(async () => {
    closing.mockRestore();
    await provider.close().catch(() => undefined);
    await browser.close();
  });

  const result = await provider.inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    }),
  );
  if (result.ok) throw new Error("Expected failure");
  expect(result.error.cleanupIncomplete).toBe(true);

  denied = false;
  await provider.close();

  expect(result.error.cleanupIncomplete).toBe(false);
  expect(result.error.diagnostics?.primary_error).toBeDefined();
  expect(JSON.stringify(result.error)).toContain("controlled primary failure");
});
