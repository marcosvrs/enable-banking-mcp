import type { ControlPanelAuth } from "./control-panel.js";
import {
  MacKeychainSecretStore,
  type SecretStore,
} from "./session-store.js";

const DEFAULT_ACCOUNT = process.env.USER?.trim() || "default";
export const DEFAULT_CONTROL_PANEL_SERVICE = "enable-banking-mcp.control-panel";

export interface ControlPanelAuthStore {
  get(): Promise<ControlPanelAuth | undefined>;
  set(auth: ControlPanelAuth): Promise<void>;
  clear(): Promise<void>;
}

export class MacKeychainControlPanelAuthStore implements ControlPanelAuthStore {
  constructor(
    private readonly secretStore: SecretStore = new MacKeychainSecretStore(
      DEFAULT_CONTROL_PANEL_SERVICE,
      DEFAULT_ACCOUNT,
      "Control Panel session",
    ),
  ) {}

  async get(): Promise<ControlPanelAuth | undefined> {
    const raw = await this.secretStore.get();
    if (!raw) return undefined;

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("Stored Control Panel session is invalid");
    }
    if (typeof value !== "object" || value === null) {
      throw new Error("Stored Control Panel session is invalid");
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
      throw new Error("Stored Control Panel session is invalid");
    }

    return {
      email: record.email,
      idToken: record.idToken,
      refreshToken: record.refreshToken,
      ...(typeof record.localId === "string" && record.localId
        ? { localId: record.localId }
        : {}),
      ...(typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)
        ? { expiresAt: record.expiresAt }
        : {}),
    };
  }

  async set(auth: ControlPanelAuth): Promise<void> {
    if (!auth.email || !auth.idToken || !auth.refreshToken) {
      throw new Error("Cannot store an incomplete Control Panel session");
    }
    await this.secretStore.set(JSON.stringify(auth));
  }

  async clear(): Promise<void> {
    await this.secretStore.clear();
  }
}
