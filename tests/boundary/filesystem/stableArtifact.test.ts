import {
  lstat,
  open,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readStableArtifact } from "../../../src/artifacts/readStableArtifact.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { RustBinaryProvider } from "../../../src/rust/RustBinaryProvider.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("reads exact binary and empty bytes and rejects symlink/size/cancellation boundaries", async () => {
  const root = await createTestTempDirectory("rea-stable-artifact-");
  const path = join(root, "source.bin");
  await writeFile(path, Buffer.from([0, 255, 254]));
  expect((await readStableArtifact(path, 3)).bytes).toEqual(
    Buffer.from([0, 255, 254]),
  );
  await expect(readStableArtifact(path, 2)).rejects.toMatchObject({
    reason: "limit",
  });
  await writeFile(path, "");
  expect((await readStableArtifact(path, 0)).bytes.length).toBe(0);
  const real = join(root, "original.bin");
  await rename(path, real);
  await symlink(real, path);
  await expect(readStableArtifact(path, 3)).rejects.toMatchObject({
    reason: "path",
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    readStableArtifact(real, 3, controller.signal),
  ).rejects.toMatchObject({
    reason: "cancelled",
    cause: controller.signal.reason,
  });
});

const checkChange = async (
  stage: "before-open" | "after-read" | "symlink-replacement",
): Promise<void> => {
  const root = await createTestTempDirectory("rea-stable-read-");
  const path = join(root, "selected");
  await writeFile(path, "original evidence");
  let inspected = 0;
  const reading = readStableArtifact(path, 1024, undefined, {
    async lstat(selected) {
      inspected++;
      if (stage === "after-read" && inspected === 2) await unlink(selected);
      const metadata = await lstat(selected, { bigint: true });
      if (inspected === 1 && stage !== "after-read") {
        await unlink(selected);
        if (stage === "symlink-replacement") await symlink("missing", selected);
      }
      return metadata;
    },
    open,
  });
  await expect(reading).rejects.toMatchObject({ reason: "integrity" });
};

it.each(["before-open", "after-read"] as const)(
  "retains an actual post-validation %s change as integrity failure",
  checkChange,
);

it.skipIf(process.platform === "win32")(
  "retains a post-validation symlink replacement as an integrity failure",
  () => checkChange("symlink-replacement"),
);

it("keeps initially missing inputs distinguishable from later changes", async () => {
  const root = await createTestTempDirectory("rea-stable-missing-");
  await expect(
    readStableArtifact(join(root, "missing"), 1024),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains exact descriptor owner, completed outcome, and cleanup observation when close fails without scope", async () => {
  const root = await createTestTempDirectory("rea-stable-close-owner-");
  const path = join(root, "input.bin");
  await writeFile(path, "caller-selected evidence");
  const closeFailure = new Error("controlled close rejection");
  let handle: any;
  let nativeClose: any;
  try {
    let caught: any;
    try {
      await readStableArtifact(path, 1024, undefined, {
        lstat: (selected) => lstat(selected, { bigint: true }),
        open: async (...args) => {
          handle = await open(...args);
          nativeClose = handle.close.bind(handle);
          handle.close = async () => {
            throw closeFailure;
          };
          return handle;
        },
      });
    } catch (cause: unknown) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(ArtifactReaderFailure);
    expect(caught.owner).toBeInstanceOf(OwnedFileHandle);
    expect(caught.owner.handle).toBe(handle);
    expect(handle.fd).toBeGreaterThanOrEqual(0);
    expect(caught.outcome).toEqual({
      kind: "completed",
      value: {
        bytes: Buffer.from("caller-selected evidence"),
        sha256: expect.any(String),
      },
    });
    expect(caught.cleanup).toEqual({
      reason: closeFailure.message,
      resources: [path],
    });
    expect(caught.cause).toBe(closeFailure);

    // Retrying close via the retained owner succeeds
    handle.close = nativeClose;
    await caught.owner.close();
    expect(handle.fd).toBe(-1);
  } finally {
    if (nativeClose && handle.fd >= 0) {
      handle.close = nativeClose;
      await nativeClose();
    }
  }
});

it("preserves earlier read failure and retains descriptor owner when close also fails without scope", async () => {
  const root = await createTestTempDirectory("rea-stable-close-primary-");
  const path = join(root, "input.bin");
  await writeFile(path, "caller-selected evidence");
  const closeFailure = new Error("controlled close rejection");
  const primary = new Error("controlled read rejection");
  let handle: any;
  let nativeClose: any;
  try {
    let caught: any;
    try {
      await readStableArtifact(path, 1024, undefined, {
        lstat: (selected) => lstat(selected, { bigint: true }),
        open: async (...args) => {
          handle = await open(...args);
          nativeClose = handle.close.bind(handle);
          handle.close = async () => {
            throw closeFailure;
          };
          handle.stat = async () => {
            throw primary;
          };
          return handle;
        },
      });
    } catch (cause: unknown) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(ArtifactReaderFailure);
    expect(caught.owner).toBeInstanceOf(OwnedFileHandle);
    expect(caught.outcome).toEqual({ kind: "failed", cause: primary });
    expect(caught.cause).toBe(primary);
    expect(caught.cleanup).toEqual({
      reason: closeFailure.message,
      resources: [path],
    });
    expect(handle.fd).toBeGreaterThanOrEqual(0);

    handle.close = nativeClose;
    await caught.owner.close();
    expect(handle.fd).toBe(-1);
  } finally {
    if (nativeClose && handle.fd >= 0) {
      handle.close = nativeClose;
      await nativeClose();
    }
  }
});

it("preserves thrown undefined failure and retains descriptor owner when close fails", async () => {
  const root = await createTestTempDirectory("rea-stable-close-undefined-");
  const path = join(root, "input.bin");
  await writeFile(path, "caller-selected evidence");
  const closeFailure = new Error("controlled close rejection");

  for (const useScope of [false, true]) {
    const scope = useScope ? new ArtifactResourceScope() : undefined;
    let handle: any;
    let nativeClose: any;
    try {
      let caught: any;
      try {
        await readStableArtifact(
          path,
          1024,
          undefined,
          {
            lstat: (selected) => lstat(selected, { bigint: true }),
            open: async (...args) => {
              handle = await open(...args);
              nativeClose = handle.close.bind(handle);
              handle.close = async () => {
                throw closeFailure;
              };
              handle.stat = async () => {
                throw undefined;
              };
              return handle;
            },
          },
          scope,
        );
      } catch (cause: unknown) {
        caught = cause;
      }
      expect(caught).toBeInstanceOf(ArtifactReaderFailure);
      expect(caught.owner).toBeInstanceOf(OwnedFileHandle);
      expect(caught.outcome).toEqual({ kind: "failed", cause: undefined });
      expect(caught.cleanup).toEqual({
        reason: closeFailure.message,
        resources: [path],
      });
      expect(handle.fd).toBeGreaterThanOrEqual(0);

      handle.close = nativeClose;
      if (scope) await scope.close();
      else await caught.owner.close();
      expect(handle.fd).toBe(-1);
    } finally {
      if (nativeClose && handle.fd >= 0) {
        handle.close = nativeClose;
        if (scope) await scope.close();
        else await nativeClose();
      }
    }
  }
});

it("adopts and retries the retained descriptor when scoped close fails", async () => {
  const root = await createTestTempDirectory("rea-stable-close-scope-");
  const path = join(root, "input.bin");
  await writeFile(path, "caller-selected evidence");
  const closeFailure = new Error("controlled close rejection");
  const scope = new ArtifactResourceScope();
  let handle: any;
  let nativeClose: any;
  try {
    let caught: any;
    try {
      await readStableArtifact(
        path,
        1024,
        undefined,
        {
          lstat: (selected) => lstat(selected, { bigint: true }),
          open: async (...args) => {
            handle = await open(...args);
            nativeClose = handle.close.bind(handle);
            handle.close = async () => {
              throw closeFailure;
            };
            return handle;
          },
        },
        scope,
      );
    } catch (cause: unknown) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(ArtifactReaderFailure);
    expect(scope.hasPending).toBe(true);
    expect(handle.fd).toBeGreaterThanOrEqual(0);

    // After restoring close capability, retrying cleanup via the scope closes the handle
    handle.close = nativeClose;
    await scope.retryCleanup();
    expect(scope.hasPending).toBe(false);
    expect(handle.fd).toBe(-1);
  } finally {
    if (nativeClose && handle.fd >= 0) {
      handle.close = nativeClose;
      await scope.close();
    }
  }
});

it("retains completed read outcome and cleanup observation if aborted during close", async () => {
  const root = await createTestTempDirectory("rea-stable-close-abort-");
  const path = join(root, "input.bin");
  await writeFile(path, "caller-selected evidence");
  const closeFailure = new Error("controlled close rejection");
  const controller = new AbortController();
  let handle: any;
  let nativeClose: any;
  try {
    let caught: any;
    try {
      await readStableArtifact(path, 1024, controller.signal, {
        lstat: (selected) => lstat(selected, { bigint: true }),
        open: async (...args) => {
          handle = await open(...args);
          nativeClose = handle.close.bind(handle);
          handle.close = async () => {
            controller.abort(new Error("aborted during close"));
            throw closeFailure;
          };
          return handle;
        },
      });
    } catch (cause: unknown) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(ArtifactReaderFailure);
    expect(caught.owner).toBeInstanceOf(OwnedFileHandle);
    expect(caught.outcome).toEqual({
      kind: "completed",
      value: {
        bytes: Buffer.from("caller-selected evidence"),
        sha256: expect.any(String),
      },
    });
    expect(caught.cleanup).toEqual({
      reason: closeFailure.message,
      resources: [path],
    });
    expect(handle.fd).toBeGreaterThanOrEqual(0);

    handle.close = nativeClose;
    await caught.owner.close();
    expect(handle.fd).toBe(-1);
  } finally {
    if (nativeClose && handle.fd >= 0) {
      handle.close = nativeClose;
      await nativeClose();
    }
  }
});

it("translates failed artifact cleanup into ProviderCleanupError in RustBinaryProvider", async () => {
  const root = await createTestTempDirectory("rea-rust-cleanup-");
  const path = join(root, "input.bin");
  await writeFile(path, "not an ELF/Mach-O/PE");
  const closeFailure = new Error("controlled close rejection");
  const originalClose = OwnedFileHandle.prototype.close;
  let closeHandle: any;
  OwnedFileHandle.prototype.close = async function (this: OwnedFileHandle) {
    closeHandle = this;
    throw closeFailure;
  };
  try {
    const provider = new RustBinaryProvider();
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ProviderCleanupError);
      expect((result.error as ProviderCleanupError).cleanupResources).toEqual([
        path,
      ]);
    }
    expect(closeHandle?.handle?.fd).toBeGreaterThanOrEqual(0);
    OwnedFileHandle.prototype.close = originalClose;
    await closeHandle?.close();
    expect(closeHandle?.handle?.fd).toBe(-1);
  } finally {
    OwnedFileHandle.prototype.close = originalClose;
    if (closeHandle?.handle?.fd >= 0) {
      await originalClose.call(closeHandle);
    }
  }
});
