import { lock as acquireCredentialLock } from "proper-lockfile";

const LOCK_OPTIONS = {
  realpath: false,
  stale: 5_000,
  update: 1_000,
  retries: 0,
};

async function acquireLockWhenAvailable(lockPath: string) {
  for (;;) {
    try {
      return await acquireCredentialLock(lockPath, LOCK_OPTIONS);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ELOCKED"
      ) {
        throw error;
      }
      const { promise, resolve } = Promise.withResolvers<undefined>();
      setTimeout(() => {
        resolve(undefined);
      }, 250);
      await promise;
    }
  }
}

const lockPath = process.argv[2];
if (!lockPath) throw new Error("Credential lock path is required");

// Keep proper-lockfile's lease heartbeat schedulable while the parent performs
// synchronous native Keychain calls that may block its event loop on a prompt.
process.stdin.resume();
const { promise: parentClosed, resolve: resolveParentClosed } =
  Promise.withResolvers<undefined>();
process.stdin.once("end", () => {
  resolveParentClosed(undefined);
});
const release = await acquireLockWhenAvailable(lockPath);
process.stdout.write("LOCKED\n");
await parentClosed;
await release();
