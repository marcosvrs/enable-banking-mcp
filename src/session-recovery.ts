import { isTerminalSessionError } from "./enable-banking.js";

export type SessionRecoveryOptions<T> = {
  storedSession?: string;
  environmentSessionId?: string;
  read: () => Promise<T>;
  clearStoredSession: () => Promise<void>;
  clearEnvironmentSession: () => void;
};

export async function recoverConfiguredSession<T>(
  options: SessionRecoveryOptions<T>,
): Promise<T | undefined> {
  const hasStoredSession = Boolean(options.storedSession);
  const hasEnvironmentSession = Boolean(options.environmentSessionId);
  if (!hasStoredSession && !hasEnvironmentSession) return undefined;

  try {
    return await options.read();
  } catch (error) {
    if (!isTerminalSessionError(error)) throw error;
    if (!hasStoredSession) {
      if (hasEnvironmentSession) options.clearEnvironmentSession();
      return undefined;
    }

    await options.clearStoredSession();
    if (!hasEnvironmentSession) return undefined;

    try {
      return await options.read();
    } catch (fallbackError) {
      if (!isTerminalSessionError(fallbackError)) throw fallbackError;
      options.clearEnvironmentSession();
      return undefined;
    }
  }
}
