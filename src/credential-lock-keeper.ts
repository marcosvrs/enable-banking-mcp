import { lock as acquireCredentialLock } from "proper-lockfile";

const LOCK_OPTIONS = {
  realpath: false,
  stale: 5_000,
  update: 1_000,
  retries: 0,
};

function waitForRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 250);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Credential lock acquisition cancelled"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function acquireLockWhenAvailable(
  lockPath: string,
  signal: AbortSignal,
) {
  for (;;) {
    signal.throwIfAborted();
    try {
      const release = await acquireCredentialLock(lockPath, LOCK_OPTIONS);
      if (signal.aborted) {
        await release();
        signal.throwIfAborted();
      }
      return release;
    } catch (error) {
      signal.throwIfAborted();
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ELOCKED"
      ) {
        throw error;
      }
      await waitForRetry(signal);
    }
  }
}

const lockPath = process.argv[2];
if (!lockPath) throw new Error("Credential lock path is required");

// Keep proper-lockfile's lease heartbeat schedulable while the parent performs
// synchronous native Keychain calls that may block its event loop on a prompt.
process.stdin.resume();
const controller = new AbortController();
const { promise: parentClosed, resolve: resolveParentClosed } =
  Promise.withResolvers<undefined>();
process.stdin.once("end", () => {
  controller.abort(new Error("Credential lock acquisition cancelled"));
  resolveParentClosed(undefined);
});
const release = await acquireLockWhenAvailable(lockPath, controller.signal).catch(
  (error: unknown) => {
    if (controller.signal.aborted) return undefined;
    throw error;
  },
);
if (release) {
  process.stdout.write("LOCKED\n");
  await parentClosed;
  await release();
}
