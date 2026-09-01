import { spawn } from "node:child_process";

export interface SecretStore {
  get(): Promise<string | undefined>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

export interface SessionStore extends SecretStore {}

type SecurityResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const SECURITY_COMMAND = "/usr/bin/security";
const DEFAULT_ACCOUNT = process.env.USER?.trim() || "default";
export const DEFAULT_SESSION_SERVICE = "enable-banking-mcp";
export const DEFAULT_APPLICATION_SERVICE = "enable-banking-mcp.application";

// Passing the value after `-w` avoids the interactive prompt used when `-w` is last.
function runSecurity(args: string[], password?: string): Promise<SecurityResult> {
  const commandArgs =
    password === undefined ? args : [...args, password];
  const { promise, resolve, reject } = Promise.withResolvers<SecurityResult>();
  const child = spawn(SECURITY_COMMAND, commandArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  if (!child.stdout || !child.stderr) {
    child.kill();
    reject(new Error("Required local credential command failed"));
    return promise;
  }
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("error", reject);
  child.once("close", (code) => {
    resolve({ code: code ?? 1, stdout, stderr });
  });
  return promise;
}

const ENCODED_SECRET_PREFIX = "enable-banking-mcp:v1:";
const CHUNK_INDEX_PREFIX = "enable-banking-mcp:chunks:v1:";
const CHUNK_SERVICE_SUFFIX = ".part.";
// Keep individual Keychain values short for compatibility with existing records.
const KEYCHAIN_CHUNK_SIZE = 80;
const MAX_KEYCHAIN_CHUNKS = 256;

function chunkService(service: string, index: number): string {
  return `${service}${CHUNK_SERVICE_SUFFIX}${index}`;
}

function parseChunkCount(value: string, label: string): number | undefined {
  if (!value.startsWith(CHUNK_INDEX_PREFIX)) {
    return undefined;
  }
  const count = Number(value.slice(CHUNK_INDEX_PREFIX.length));
  if (!Number.isInteger(count) || count < 1 || count > MAX_KEYCHAIN_CHUNKS) {
    throw new Error(`Stored Enable Banking ${label} is invalid`);
  }
  return count;
}

function decodeStoredSecret(value: string, label: string): string {
  // Keep pre-v1 raw Keychain records readable; the next write upgrades them.
  if (!value.startsWith(ENCODED_SECRET_PREFIX)) {
    return value;
  }
  const encoded = value.slice(ENCODED_SECRET_PREFIX.length);
  if (
    !encoded ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new Error(`Stored Enable Banking ${label} is invalid`);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    throw new Error(`Stored Enable Banking ${label} is invalid`);
  }
  return decoded.toString("utf8");
}

export class MacKeychainSecretStore implements SecretStore {
  constructor(
    private readonly service: string,
    private readonly account = DEFAULT_ACCOUNT,
    private readonly label = "secret",
  ) {}

  private async readRaw(service: string): Promise<string | undefined> {
    const result = await runSecurity([
      "find-generic-password",
      "-a",
      this.account,
      "-s",
      service,
      "-w",
    ]);
    if (result.code !== 0) {
      if (
        result.code === 44 ||
        /specified item could not be found/i.test(result.stderr)
      ) {
        return undefined;
      }
      throw new Error(`Unable to read the Enable Banking ${this.label} from Keychain`);
    }
    return result.stdout.trim();
  }

  private async writeRaw(service: string, value: string): Promise<void> {
    const result = await runSecurity(
      [
        "add-generic-password",
        "-a",
        this.account,
        "-s",
        service,
        "-U",
        "-T",
        SECURITY_COMMAND,
        "-w",
      ],
      value,
    );
    if (result.code !== 0) {
      throw new Error(`Unable to store the Enable Banking ${this.label} in Keychain`);
    }
  }

  private async deleteRaw(service: string): Promise<void> {
    const result = await runSecurity([
      "delete-generic-password",
      "-a",
      this.account,
      "-s",
      service,
    ]);
    if (
      result.code !== 0 &&
      result.code !== 44 &&
      !/specified item could not be found/i.test(result.stderr)
    ) {
      throw new Error(`Unable to clear the Enable Banking ${this.label} from Keychain`);
    }
  }

  async get(): Promise<string | undefined> {
    const value = await this.readRaw(this.service);
    if (value === undefined) {
      return undefined;
    }
    const chunkCount = parseChunkCount(value, this.label);
    if (chunkCount === undefined) {
      return decodeStoredSecret(value, this.label);
    }

    const chunks = await Promise.all(
      Array.from({ length: chunkCount }, (_, index) =>
        this.readRaw(chunkService(this.service, index)),
      ),
    );
    const encoded = chunks
      .map((chunk) => {
        if (chunk === undefined) {
          throw new Error(`Stored Enable Banking ${this.label} is invalid`);
        }
        return chunk;
      })
      .join("");
    if (!encoded.startsWith(ENCODED_SECRET_PREFIX)) {
      throw new Error(`Stored Enable Banking ${this.label} is invalid`);
    }
    return decodeStoredSecret(encoded, this.label);
  }

  async set(value: string): Promise<void> {
    const normalized = value.trim();
    if (!normalized) {
      throw new Error(`Cannot store an empty Enable Banking ${this.label}`);
    }
    const encoded =
      `${ENCODED_SECRET_PREFIX}${Buffer.from(normalized, "utf8").toString("base64")}`;
    const chunks: string[] = [];
    for (let offset = 0; offset < encoded.length; offset += KEYCHAIN_CHUNK_SIZE) {
      chunks.push(encoded.slice(offset, offset + KEYCHAIN_CHUNK_SIZE));
    }
    if (chunks.length > MAX_KEYCHAIN_CHUNKS) {
      throw new Error(`Enable Banking ${this.label} is too large for Keychain storage`);
    }

    const previous = await this.readRaw(this.service);
    const previousChunkCount =
      previous === undefined ? undefined : parseChunkCount(previous, this.label);
    await Promise.all(
      chunks.map((chunk, index) =>
        this.writeRaw(chunkService(this.service, index), chunk),
      ),
    );
    await this.writeRaw(
      this.service,
      `${CHUNK_INDEX_PREFIX}${chunks.length}`,
    );
    if (previousChunkCount !== undefined && previousChunkCount > chunks.length) {
      await Promise.all(
        Array.from(
          { length: previousChunkCount - chunks.length },
          (_, index) =>
            this.deleteRaw(chunkService(this.service, chunks.length + index)),
        ),
      );
    }
  }

  async clear(): Promise<void> {
    const value = await this.readRaw(this.service);
    const chunkCount =
      value === undefined ? undefined : parseChunkCount(value, this.label);
    await this.deleteRaw(this.service);
    if (chunkCount !== undefined) {
      await Promise.all(
        Array.from({ length: chunkCount }, (_, index) =>
          this.deleteRaw(chunkService(this.service, index)),
        ),
      );
    }
  }
}

export class MacKeychainSessionStore
  extends MacKeychainSecretStore
  implements SessionStore
{
  constructor(
    service = DEFAULT_SESSION_SERVICE,
    account = DEFAULT_ACCOUNT,
  ) {
    super(service, account, "session");
  }
}
