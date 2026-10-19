import { Effect } from "effect";
import type { ControlPanelAuth } from "./control-panel.js";
import {
  MacKeychainSecretStore,
  type SecretStore,
} from "./session-store.js";


export interface ControlPanelAuthStore {
  get(): Effect.Effect<ControlPanelAuth | undefined, unknown>;
  set(auth: ControlPanelAuth): Effect.Effect<void, unknown>;
  clear(): Effect.Effect<void, unknown>;
}

export class MacKeychainControlPanelAuthStore implements ControlPanelAuthStore {
  constructor(
    private readonly secretStore: SecretStore = new MacKeychainSecretStore(
      "controlPanel",
    ),
  ) {}

  get(): Effect.Effect<ControlPanelAuth | undefined, unknown> {
    return Effect.gen(this, function* (this: MacKeychainControlPanelAuthStore) {
      const raw = yield* this.secretStore.get();
      if (!raw) return undefined;

      const value = yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: () => new Error("Stored Control Panel session is invalid"),
      });
      if (typeof value !== "object" || value === null) {
        return yield* Effect.fail(
          new Error("Stored Control Panel session is invalid"),
        );
      }
      const record = value as Record<string, unknown>;
      if (
        typeof record.email !== "string" ||
        typeof record.idToken !== "string" ||
        typeof record.refreshToken !== "string" ||
        !record.email ||
        !record.idToken ||
        !record.refreshToken
      ) {
        return yield* Effect.fail(
          new Error("Stored Control Panel session is invalid"),
        );
      }

      return {
        email: record.email,
        idToken: record.idToken,
        refreshToken: record.refreshToken,
        ...(typeof record.localId === "string" && record.localId
          ? { localId: record.localId }
          : {}),
        ...(typeof record.expiresAt === "number" &&
        Number.isFinite(record.expiresAt)
          ? { expiresAt: record.expiresAt }
          : {}),
      };
    });
  }

  set(auth: ControlPanelAuth): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* (this: MacKeychainControlPanelAuthStore) {
      if (!auth.email || !auth.idToken || !auth.refreshToken) {
        return yield* Effect.fail(
          new Error("Cannot store an incomplete Control Panel session"),
        );
      }
      yield* this.secretStore.set(JSON.stringify(auth));
    });
  }

  clear(): Effect.Effect<void, unknown> {
    return this.secretStore.clear();
  }
}
