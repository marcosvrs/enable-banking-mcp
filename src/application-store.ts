import { Effect } from "effect";
import { MacKeychainSecretStore, type SecretStore } from "./session-store.js";

export type ApplicationEnvironment = "PRODUCTION" | "SANDBOX";

export interface StoredApplication {
  appId: string;
  privateKey: string;
  certificate: string;
  environment: ApplicationEnvironment;
  redirectUrls: string[];
}

export interface ApplicationStore {
  get(): Effect.Effect<StoredApplication | undefined, unknown>;
  set(application: StoredApplication): Effect.Effect<void, unknown>;
  clear(): Effect.Effect<void, unknown>;
}

export class MacKeychainApplicationStore implements ApplicationStore {
  constructor(
    private readonly secretStore: SecretStore = new MacKeychainSecretStore(
      "application",
    ),
  ) {}

  get(): Effect.Effect<StoredApplication | undefined, unknown> {
    return Effect.gen(this, function* (this: MacKeychainApplicationStore) {
      const raw = yield* this.secretStore.get();
      if (!raw) return undefined;

      const parsed = yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: () =>
          new Error("Stored Enable Banking application credentials are invalid"),
      });
      if (!isStoredApplication(parsed)) {
        return yield* Effect.fail(
          new Error("Stored Enable Banking application credentials are invalid"),
        );
      }
      return parsed;
    });
  }

  set(application: StoredApplication): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* (this: MacKeychainApplicationStore) {
      if (!isStoredApplication(application)) {
        return yield* Effect.fail(
          new Error("Enable Banking application credentials are invalid"),
        );
      }
      yield* this.secretStore.set(JSON.stringify(application));
    });
  }

  clear(): Effect.Effect<void, unknown> {
    return this.secretStore.clear();
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
