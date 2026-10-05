import { Entry } from "@napi-rs/keyring";
import { spawn } from "node:child_process";

export interface SecretStore {
  get(): Promise<string | undefined>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

export type SessionStore = SecretStore;

interface SecurityResult {
  code: number;
  stdout: string;
  stderr: string;
}
type SecurityRunner = (args: string[]) => Promise<SecurityResult>;
export interface NativeKeyringEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}
export type NativeKeyringEntryFactory = (
  service: string,
  account: string,
) => NativeKeyringEntry;

const SECURITY_COMMAND = "/usr/bin/security";
const DEFAULT_ACCOUNT = process.env.USER?.trim() || "default";
export const DEFAULT_SESSION_SERVICE = "enable-banking-mcp";
export const DEFAULT_APPLICATION_SERVICE = "enable-banking-mcp.application";
const NATIVE_SERVICE_SUFFIX = ".native";
let nativeKeyringEntryFactory: NativeKeyringEntryFactory = (
  serviceName,
  username,
) => new Entry(serviceName, username);

// Allows isolated runtimes to inject an in-memory native keyring implementation.
export function setNativeKeyringEntryFactory(
  factory: NativeKeyringEntryFactory,
): void {
  nativeKeyringEntryFactory = factory;
}

function runSecurity(args: string[]): Promise<SecurityResult> {
  const { promise, resolve, reject } = Promise.withResolvers<SecurityResult>();
  const child = spawn(SECURITY_COMMAND, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  // Child process mocks or runtime failures may not honor Node's declared pipe streams.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Keep the runtime failure path.
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
const CHUNK_INDEX_V2_PREFIX = "enable-banking-mcp:chunks:v2:";
const CHUNK_SERVICE_SUFFIX = ".part.";
const RETIRED_SERVICE_SUFFIX = ".retired";
const PENDING_SERVICE_SUFFIX = ".pending";
const MAX_KEYCHAIN_CHUNKS = 256;

interface ChunkGeneration { id: string; count: number }
interface ChunkManifest { active: ChunkGeneration; retired: ChunkGeneration[] }

function chunkService(service: string, index: number): string {
  return `${service}${CHUNK_SERVICE_SUFFIX}${index}`;
}

function generationChunkService(
  service: string,
  generation: ChunkGeneration,
  index: number,
): string {
  return generation.id === "legacy"
    ? chunkService(service, index)
    : `${service}${CHUNK_SERVICE_SUFFIX}${generation.id}.${index}`;
}
function parseManifest(value: string, label: string): ChunkManifest | undefined {
  if (value.startsWith(CHUNK_INDEX_V2_PREFIX)) {
    const [activeText, ...retiredTexts] = value
      .slice(CHUNK_INDEX_V2_PREFIX.length)
      .split(";");
    const parseGeneration = (text: string | undefined): ChunkGeneration => {
      const match = text?.match(/^([a-zA-Z0-9-]+),([1-9]\d*)$/);
      const id = match?.[1];
      const count = match ? Number(match[2]) : NaN;
      if (!match || !id || !Number.isInteger(count) || count > MAX_KEYCHAIN_CHUNKS) {
        throw new Error(`Stored Enable Banking ${label} is invalid`);
      }
      return { id, count };
    };
    return {
      active: parseGeneration(activeText),
      retired: retiredTexts.filter(Boolean).map(parseGeneration),
    };
  }
  if (value.startsWith(CHUNK_INDEX_PREFIX)) {
    const count = Number(value.slice(CHUNK_INDEX_PREFIX.length));
    if (!Number.isInteger(count) || count < 1 || count > MAX_KEYCHAIN_CHUNKS) {
      throw new Error(`Stored Enable Banking ${label} is invalid`);
    }
    return {
      active: { id: "legacy", count },
      retired: [],
    };
  }
  return undefined;
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
  private readonly nativeEntry: NativeKeyringEntry;

  constructor(
    private readonly service: string,
    private readonly account = DEFAULT_ACCOUNT,
    private readonly label = "secret",
    private readonly securityRunner: SecurityRunner = runSecurity,
    nativeEntryFactory: NativeKeyringEntryFactory = nativeKeyringEntryFactory,
  ) {
    // A distinct service avoids inheriting ACLs from legacy `security` items.
    this.nativeEntry = nativeEntryFactory(
      `${service}${NATIVE_SERVICE_SUFFIX}`,
      account,
    );
  }

  private async readRaw(service: string): Promise<string | undefined> {
    const result = await this.securityRunner([
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

  private async deleteRaw(service: string): Promise<void> {
    const result = await this.securityRunner([
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

  private async readManifest(): Promise<ChunkManifest | undefined> {
    const value = await this.readRaw(this.service);
    return value === undefined ? undefined : parseManifest(value, this.label);
  }

  private async deleteGeneration(generation: ChunkGeneration): Promise<void> {
    for (let index = 0; index < generation.count; index += 1) {
      await this.deleteRaw(
        generationChunkService(this.service, generation, index),
      );
    }
  }

  private async recoverPendingWrite(): Promise<void> {
    const pendingService = `${this.service}${PENDING_SERVICE_SUFFIX}`;
    const pendingValue = await this.readRaw(pendingService);
    if (pendingValue === undefined) return;
    const match = /^([a-zA-Z0-9-]+),([1-9]\d*)$/.exec(pendingValue);
    const id = match?.[1];
    const count = match ? Number(match[2]) : NaN;
    if (!match || !id || !Number.isInteger(count) || count > MAX_KEYCHAIN_CHUNKS) {
      throw new Error(`Stored Enable Banking ${this.label} is invalid`);
    }
    const pending = { id, count };
    const manifest = await this.readManifest();
    if (manifest?.active.id !== pending.id) {
      await this.deleteGeneration(pending);
    }
    await this.deleteRaw(pendingService);
  }

  private async recoverRetiredWrite(): Promise<void> {
    const retiredService = `${this.service}${RETIRED_SERVICE_SUFFIX}`;
    const retiredValue = await this.readRaw(retiredService);
    const manifest = await this.readManifest().catch((error: unknown) => {
      if (retiredValue !== undefined) throw error;
      return undefined;
    });
    if (retiredValue !== undefined) {
      const match = /^([a-zA-Z0-9-]+),([1-9]\d*)$/.exec(retiredValue);
      const id = match?.[1];
      const count = match ? Number(match[2]) : NaN;
      if (!match || !id || !Number.isInteger(count) || count > MAX_KEYCHAIN_CHUNKS) {
        throw new Error(`Stored Enable Banking ${this.label} is invalid`);
      }
      const retired = { id, count };
      if (manifest?.active.id !== retired.id) {
        await this.deleteGeneration(retired);
      }
      await this.deleteRaw(retiredService);
    }
    if (manifest?.retired.length) {
      for (const generation of manifest.retired) {
        await this.deleteGeneration(generation);
      }
    }
  }

  private async readLegacy(): Promise<string | undefined> {
    const value = await this.readRaw(this.service);
    if (value === undefined) return undefined;
    const manifest = parseManifest(value, this.label);
    if (manifest === undefined) return decodeStoredSecret(value, this.label);
    const chunks = await Promise.all(
      Array.from({ length: manifest.active.count }, (_, index) =>
        this.readRaw(
          generationChunkService(this.service, manifest.active, index),
        ),
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

  async get(): Promise<string | undefined> {
    const value = this.nativeEntry.getPassword();
    return value ?? this.readLegacy();
  }

  async set(value: string): Promise<void> {
    const normalized = value.trim();
    if (!normalized) {
      throw new Error(`Cannot store an empty Enable Banking ${this.label}`);
    }
    // Commit the new record first: legacy cleanup failure cannot hide it.
    this.nativeEntry.setPassword(normalized);
    await this.recoverPendingWrite();
    await this.recoverRetiredWrite();
    await this.clearLegacy();
  }

  private async clearLegacy(): Promise<void> {
    const errors: unknown[] = [];
    const attempt = async (operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };
    const value = await this.readRaw(this.service).catch((error: unknown) => {
      errors.push(error);
      return undefined;
    });
    let manifest: ChunkManifest | undefined;
    if (value !== undefined) {
      try {
        manifest = parseManifest(value, this.label);
      } catch {
        // Malformed records are still removable below.
      }
    }
    const malformedManifest =
      value !== undefined &&
      (value.startsWith(CHUNK_INDEX_PREFIX) ||
        value.startsWith(CHUNK_INDEX_V2_PREFIX)) &&
      manifest === undefined;
    if (!malformedManifest) {
      await attempt(() => this.recoverRetiredWrite());
      await attempt(() => this.recoverPendingWrite());
    }
    if (manifest) {
      await attempt(() => this.deleteGeneration(manifest.active));
      for (const generation of manifest.retired) {
        await attempt(() => this.deleteGeneration(generation));
      }
    } else if (value?.startsWith(CHUNK_INDEX_PREFIX)) {
      // Malformed v1 indexes cannot identify their chunks; remove every bounded legacy slot.
      for (let index = 0; index < MAX_KEYCHAIN_CHUNKS; index += 1) {
        await attempt(() => this.deleteRaw(chunkService(this.service, index)));
      }
    } else if (value?.startsWith(CHUNK_INDEX_V2_PREFIX)) {
      const generationEntries = value
        .slice(CHUNK_INDEX_V2_PREFIX.length)
        .split(";");
      const generations = generationEntries
        .map((item) => /^([a-zA-Z0-9-]+),/.exec(item)?.[1])
        .filter((generation): generation is string => generation !== undefined);
      if (generations.length !== generationEntries.length) {
        errors.push(new Error("Unable to identify every legacy chunk generation"));
      }
      for (const generation of generations) {
        await attempt(async () => {
          for (let index = 0; index < MAX_KEYCHAIN_CHUNKS; index += 1) {
            await this.deleteRaw(
              `${this.service}${CHUNK_SERVICE_SUFFIX}${generation}.${index}`,
            );
          }
        });
      }
    }
    if (errors.length === 0) {
      await attempt(() =>
        this.deleteRaw(`${this.service}${PENDING_SERVICE_SUFFIX}`),
      );
      await attempt(() =>
        this.deleteRaw(`${this.service}${RETIRED_SERVICE_SUFFIX}`),
      );
      await attempt(() => this.deleteRaw(this.service));
    }
    if (errors.length) {
      throw new AggregateError(
        errors,
        `Unable to clear legacy Enable Banking ${this.label} from Keychain`,
      );
    }
  }

  async clear(): Promise<void> {
    const errors: unknown[] = [];
    try {
      this.nativeEntry.deletePassword();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.clearLegacy();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      throw new AggregateError(
        errors,
        `Unable to clear the Enable Banking ${this.label} from Keychain`,
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
