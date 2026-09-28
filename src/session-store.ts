import { Effect } from "effect";
import { Entry } from "@napi-rs/keyring";

export interface SecretStore {
  get(): Effect.Effect<string | undefined, unknown>;
  set(value: string): Effect.Effect<void, unknown>;
  clear(): Effect.Effect<void, unknown>;
}

export interface SessionStore extends SecretStore {}

export type NativeKeyringEntry = {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
};
export type NativeKeyringEntryFactory = (
  service: string,
  account: string,
) => NativeKeyringEntry;

type CredentialSlot = "session" | "application" | "controlPanel";
type CredentialBundle = Partial<Record<CredentialSlot, string>>;
type EntryCandidate = {
  service: string;
  slot?: CredentialSlot;
  entry: NativeKeyringEntry;
};

const DEFAULT_ACCOUNT = process.env.USER?.trim() || "default";
const BUNDLE_PREFIX = "enable-banking-mcp:credential-bundle:v1:";
const DEFAULT_CREDENTIAL_SERVICE = "enable-banking-mcp.credentials.native";
const CREDENTIAL_CANDIDATES: ReadonlyArray<{
  service: string;
  slot?: CredentialSlot;
}> = [
  { service: DEFAULT_CREDENTIAL_SERVICE },
  { service: "enable-banking-mcp.control-panel.native", slot: "controlPanel" },
  { service: "enable-banking-mcp.application.native", slot: "application" },
  { service: "enable-banking-mcp.native", slot: "session" },
  { service: "enable-banking-mcp.control-panel", slot: "controlPanel" },
  { service: "enable-banking-mcp.application", slot: "application" },
  { service: "enable-banking-mcp", slot: "session" },
  { service: "enable-banking-mcp.control-panel.pending" },
  { service: "enable-banking-mcp.control-panel.retired" },
  { service: "enable-banking-mcp.application.pending" },
  { service: "enable-banking-mcp.application.retired" },
  { service: "enable-banking-mcp.pending" },
  { service: "enable-banking-mcp.retired" },
];

let nativeKeyringEntryFactory: NativeKeyringEntryFactory = (
  serviceName,
  username,
) => new Entry(serviceName, username);
let defaultVault: MacKeychainCredentialVault | undefined;

// Allows isolated runtimes to inject an in-memory native keyring implementation.
export function setNativeKeyringEntryFactory(
  factory: NativeKeyringEntryFactory,
): void {
  nativeKeyringEntryFactory = factory;
  defaultVault = undefined;
}

function parseBundle(value: string): CredentialBundle {
  if (!value.startsWith(BUNDLE_PREFIX)) {
    throw new Error("Stored Enable Banking credential vault is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(BUNDLE_PREFIX.length));
  } catch {
    throw new Error("Stored Enable Banking credential vault is invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored Enable Banking credential vault is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error("Stored Enable Banking credential vault is invalid");
  }
  const bundle: CredentialBundle = {};
  for (const slot of ["session", "application", "controlPanel"] as const) {
    const valueForSlot = record[slot];
    if (valueForSlot === undefined) continue;
    if (typeof valueForSlot !== "string" || !valueForSlot.trim()) {
      throw new Error("Stored Enable Banking credential vault is invalid");
    }
    bundle[slot] = valueForSlot;
  }
  return bundle;
}


function mergeBundle(target: CredentialBundle, source: CredentialBundle): void {
  for (const slot of ["session", "application", "controlPanel"] as const) {
    if (target[slot] === undefined && source[slot] !== undefined) {
      target[slot] = source[slot];
    }
  }
}

export class MacKeychainCredentialVault {
  private readonly candidates: EntryCandidate[];
  private activeEntry: NativeKeyringEntry | undefined;
  private bundle: CredentialBundle = {};
  private initialized = false;

  constructor(
    entryFactory: NativeKeyringEntryFactory = nativeKeyringEntryFactory,
    account = DEFAULT_ACCOUNT,
  ) {
    this.candidates = CREDENTIAL_CANDIDATES.map(({ service, slot }) => ({
      service,
      ...(slot ? { slot } : {}),
      entry: entryFactory(service, account),
    }));
  }

  private initialize(): void {
    if (this.initialized) return;
    const found = this.candidates.map((candidate) => ({
      ...candidate,
      value: candidate.entry.getPassword(),
    }));
    const existing = found.filter(
      (candidate): candidate is EntryCandidate & { value: string } =>
        candidate.value !== null,
    );
    const storedBundle = existing.find((candidate) =>
      candidate.value.startsWith(BUNDLE_PREFIX),
    );
    const selected = storedBundle ?? existing[0];
    if (!selected) {
      this.activeEntry = this.candidates[0].entry;
      this.bundle = {};
      this.initialized = true;
      return;
    }

    const merged: CredentialBundle = {};
    for (const candidate of existing) {
      if (
        candidate.service.endsWith(".pending") ||
        candidate.service.endsWith(".retired") ||
        candidate.value.startsWith("enable-banking-mcp:chunks:v1:") ||
        candidate.value.startsWith("enable-banking-mcp:chunks:v2:")
      ) {
        throw new Error(
          "Legacy chunked Enable Banking Keychain records must be cleared before storing credentials",
        );
      }
      if (candidate.value.startsWith(BUNDLE_PREFIX)) {
        mergeBundle(merged, parseBundle(candidate.value));
      } else if (candidate.slot && merged[candidate.slot] === undefined) {
        const legacyPrefix = "enable-banking-mcp:v1:";
        let legacyValue = candidate.value;
        if (legacyValue.startsWith(legacyPrefix)) {
          const encoded = legacyValue.slice(legacyPrefix.length);
          if (
            !encoded ||
            encoded.length % 4 !== 0 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
          ) {
            throw new Error("Stored Enable Banking credential vault is invalid");
          }
          const decoded = Buffer.from(encoded, "base64");
          if (decoded.toString("base64") !== encoded) {
            throw new Error("Stored Enable Banking credential vault is invalid");
          }
          legacyValue = decoded.toString("utf8");
        }
        if (!legacyValue.trim()) {
          throw new Error("Stored Enable Banking credential vault is invalid");
        }
        merged[candidate.slot] = legacyValue;
      } else if (!candidate.slot) {
        throw new Error("Stored Enable Banking credential vault is invalid");
      }
    }

    this.activeEntry = selected.entry;
    if (
      !selected.value.startsWith(BUNDLE_PREFIX) ||
      existing.some((candidate) => candidate.entry !== selected.entry)
    ) {
      selected.entry.setPassword(
        `${BUNDLE_PREFIX}${JSON.stringify({ version: 1, ...merged })}`,
      );
    }

    const cleanupErrors: unknown[] = [];
    for (const candidate of existing) {
      if (candidate.entry === selected.entry) continue;
      try {
        candidate.entry.deletePassword();
        if (candidate.entry.getPassword() !== null) {
          cleanupErrors.push(
            new Error(
              `Duplicate Enable Banking Keychain item remains: ${candidate.service}`,
            ),
          );
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        cleanupErrors,
        "Unable to remove duplicate Enable Banking Keychain entries",
      );
    }
    this.bundle = merged;
    this.initialized = true;
  }

  get(slot: CredentialSlot): Effect.Effect<string | undefined, unknown> {
    return Effect.try({
      try: () => {
        this.initialize();
        return this.bundle[slot];
      },
      catch: (error) => error,
    });
  }

  set(slot: CredentialSlot, value: string): Effect.Effect<void, unknown> {
    return Effect.try({
      try: () => {
        const normalized = value.trim();
        if (!normalized) {
          throw new Error(`Cannot store an empty Enable Banking ${slot}`);
        }
        this.initialize();
        if (!this.activeEntry) {
          throw new Error("Enable Banking Keychain entry is unavailable");
        }
        const next = { ...this.bundle, [slot]: normalized };
        // initialize() has checked every known app-owned service for an entry.
        this.activeEntry.setPassword(
          `${BUNDLE_PREFIX}${JSON.stringify({ version: 1, ...next })}`,
        );
        this.bundle = next;
      },
      catch: (error) => error,
    });
  }

  clear(slot: CredentialSlot): Effect.Effect<void, unknown> {
    return Effect.try({
      try: () => {
        this.initialize();
        if (this.bundle[slot] === undefined) return;
        const next = { ...this.bundle };
        delete next[slot];
        if (Object.keys(next).length === 0) {
          const entry = this.activeEntry;
          if (!entry) {
            throw new Error("Enable Banking Keychain entry is unavailable");
          }
          entry.deletePassword();
          if (entry.getPassword() !== null) {
            throw new Error("Unable to remove Enable Banking Keychain item");
          }
          this.bundle = {};
          this.initialized = false;
          this.activeEntry = undefined;
          return;
        }
        this.activeEntry?.setPassword(
          `${BUNDLE_PREFIX}${JSON.stringify({ version: 1, ...next })}`,
        );
        this.bundle = next;
      },
      catch: (error) => error,
    });
  }
}

function getDefaultVault(): MacKeychainCredentialVault {
  defaultVault ??= new MacKeychainCredentialVault();
  return defaultVault;
}

export class MacKeychainSecretStore implements SecretStore {
  constructor(
    private readonly slot: CredentialSlot,
    private readonly vault = getDefaultVault(),
  ) {}

  get(): Effect.Effect<string | undefined, unknown> {
    return this.vault.get(this.slot);
  }

  set(value: string): Effect.Effect<void, unknown> {
    return this.vault.set(this.slot, value);
  }

  clear(): Effect.Effect<void, unknown> {
    return this.vault.clear(this.slot);
  }
}

export class MacKeychainSessionStore extends MacKeychainSecretStore implements SessionStore {
  constructor(vault = getDefaultVault()) {
    super("session", vault);
  }
}
