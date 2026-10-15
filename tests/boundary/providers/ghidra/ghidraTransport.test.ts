import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import {
  createGhidraTestRuntime,
  publishGhidraTestEndpoint,
} from "../../../fixtures/ghidraRuntime.js";
import type { PrivateRuntimeRoot } from "../../../../src/process/PrivateRuntimeRoot.js";

import { observeGhidraEndpoint } from "../../../../src/ghidra/GhidraTransport.js";

const roots: string[] = [];
const runtimes: PrivateRuntimeRoot[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Ghidra local transport", () => {
  it("observes Unix readiness without interpreting endpoint content", async () => {
    const root = await createTestTempDirectory("rea-ghidra-transport-");
    roots.push(root);
    const path = join(root, "bridge.sock");

    await expect(
      observeGhidraEndpoint({ transport: "unix-socket", path }),
    ).resolves.toEqual({ ok: true, value: null });
    await writeFile(path, "fixture");
    await expect(
      observeGhidraEndpoint({ transport: "unix-socket", path }),
    ).resolves.toEqual({ ok: true, value: { path } });
  });

  it("accepts only an exact IPv4 loopback endpoint record", async () => {
    const root = await createTestTempDirectory("rea-ghidra-transport-");
    roots.push(root);
    const runtime = await createGhidraTestRuntime(root);
    runtimes.push(runtime);
    const path = await publishGhidraTestEndpoint(
      runtime,
      `${JSON.stringify({ host: "127.0.0.1", port: 49152 })}\n`,
    );

    await expect(
      observeGhidraEndpoint({
        transport: "authenticated-loopback-tcp",
        path,
      }),
    ).resolves.toEqual({
      ok: true,
      value: { host: "127.0.0.1", port: 49152 },
    });
  });

  it.each([
    { host: "0.0.0.0", port: 49152 },
    { host: "127.0.0.1", port: 0 },
    { host: "127.0.0.1", port: 49152, token: "leak" },
  ])(
    "rejects an invalid or expanded TCP endpoint: $host:$port",
    async (value) => {
      const root = await createTestTempDirectory("rea-ghidra-transport-");
      roots.push(root);
      const runtime = await createGhidraTestRuntime(root);
      runtimes.push(runtime);
      const path = await publishGhidraTestEndpoint(
        runtime,
        JSON.stringify(value),
      );

      await expect(
        observeGhidraEndpoint({
          transport: "authenticated-loopback-tcp",
          path,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { kind: "start", message: "Ghidra TCP endpoint is invalid" },
      });
    },
  );

  it.each([
    { win32Code: 2, label: "file not found" },
    { win32Code: 3, label: "path not found" },
    { win32Code: 32, label: "sharing violation" },
    { win32Code: 33, label: "lock violation" },
  ])(
    "treats Windows $label (win32Code: $win32Code) as transient readiness",
    async ({ win32Code }) => {
      const error = Object.assign(new Error("Native Win32 error"), {
        code: "ERR_REA_WINDOWS_NATIVE",
        win32Code,
      });
      const readWindowsFile = () => {
        throw error;
      };
      await expect(
        observeGhidraEndpoint(
          {
            transport: "authenticated-loopback-tcp",
            path: "C:\\runtime\\bridge-endpoint.json",
          },
          "win32",
          readWindowsFile,
        ),
      ).resolves.toEqual({ ok: true, value: null });
    },
  );

  it("fails observation when Windows encounters non-transient error", async () => {
    const error = Object.assign(new Error("Native access denied"), {
      code: "ERR_REA_WINDOWS_NATIVE",
      win32Code: 5,
    });
    const readWindowsFile = () => {
      throw error;
    };
    await expect(
      observeGhidraEndpoint(
        {
          transport: "authenticated-loopback-tcp",
          path: "C:\\runtime\\bridge-endpoint.json",
        },
        "win32",
        readWindowsFile,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "start",
        message: "Ghidra endpoint observation failed",
      },
    });
  });

  it("parses valid TCP endpoint on Windows platform", async () => {
    const readWindowsFile = () =>
      JSON.stringify({ host: "127.0.0.1", port: 51234 });
    await expect(
      observeGhidraEndpoint(
        {
          transport: "authenticated-loopback-tcp",
          path: "C:\\runtime\\bridge-endpoint.json",
        },
        "win32",
        readWindowsFile,
      ),
    ).resolves.toEqual({
      ok: true,
      value: { host: "127.0.0.1", port: 51234 },
    });
  });
});
