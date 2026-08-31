import {
  DEFAULT_APPLICATION_SERVICE,
  MacKeychainSecretStore,
  type SecretStore,
} from "./session-store.js";

export type ApplicationEnvironment = "PRODUCTION" | "SANDBOX";

export interface StoredApplication {
  appId: string;
  privateKey: string;
  certificate: string;
  environment: ApplicationEnvironment;
  redirectUrls: string[];
}

export interface ApplicationStore {
  get(): Promise<StoredApplication | undefined>;
  set(application: StoredApplication): Promise<void>;
  clear(): Promise<void>;
}

export class MacKeychainApplicationStore implements ApplicationStore {
  constructor(
    private readonly secretStore: SecretStore = new MacKeychainSecretStore(
      DEFAULT_APPLICATION_SERVICE,
      undefined,
      "application credentials",
    ),
  ) {}

  async get(): Promise<StoredApplication | undefined> {
    const raw = await this.secretStore.get();
    if (!raw) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Stored Enable Banking application credentials are invalid");
    }
    if (!isStoredApplication(parsed)) {
      throw new Error("Stored Enable Banking application credentials are invalid");
    }
    return parsed;
  }

  async set(application: StoredApplication): Promise<void> {
    if (!isStoredApplication(application)) {
      throw new Error("Enable Banking application credentials are invalid");
    }
    await this.secretStore.set(JSON.stringify(application));
  }

  async clear(): Promise<void> {
    await this.secretStore.clear();
  }
}

function isStoredApplication(value: unknown): value is StoredApplication {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.appId === "string" &&
    record.appId.trim().length > 0 &&
    typeof record.privateKey === "string" &&
    record.privateKey.trim().length > 0 &&
    typeof record.certificate === "string" &&
    record.certificate.trim().length > 0 &&
    (record.environment === "PRODUCTION" || record.environment === "SANDBOX") &&
    Array.isArray(record.redirectUrls) &&
    record.redirectUrls.length > 0 &&
    record.redirectUrls.every(
      (url) => typeof url === "string" && url.trim().length > 0,
    )
  );
}
