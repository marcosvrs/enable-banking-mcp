import { lock as acquireCredentialLock } from "proper-lockfile";

const LOCK_OPTIONS = {
  realpath: false,
  stale: 5_000,
  update: 1_000,
  retries: { retries: 100, factor: 1, minTimeout: 100, maxTimeout: 200 },
};

const lockPath = process.argv[2];
if (!lockPath) throw new Error("Credential lock path is required");

// Keep proper-lockfile's lease heartbeat schedulable while the parent performs
// synchronous native Keychain calls that may block its event loop on a prompt.
process.stdin.resume();
const parentClosed = new Promise<void>((resolve) => {
  process.stdin.once("end", resolve);
});
const release = await acquireCredentialLock(lockPath, LOCK_OPTIONS);
process.stdout.write("LOCKED\n");
await parentClosed;
await release();
