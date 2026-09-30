import { Effect, Either } from "effect";

import { isTerminalSessionError } from "./enable-banking.js";

export type SessionRecoveryOptions<T> = {
  storedSession?: string;
  environmentSessionId?: string;
  read: () => Effect.Effect<T, unknown>;
  clearStoredSession: () => Effect.Effect<void, unknown>;
  clearEnvironmentSession: () => void;
};

export function recoverConfiguredSession<T>(
  options: SessionRecoveryOptions<T>,
): Effect.Effect<T | undefined, unknown> {
  return Effect.gen(function* () {
    const hasStoredSession = Boolean(options.storedSession);
    const hasEnvironmentSession = Boolean(options.environmentSessionId);
    if (!hasStoredSession && !hasEnvironmentSession) return undefined;

    const initial = yield* Effect.either(options.read());
    if (Either.isRight(initial)) return initial.right;
    if (!isTerminalSessionError(initial.left)) return yield* Effect.fail(initial.left);
    if (!hasStoredSession) {
      options.clearEnvironmentSession();
      return undefined;
    }

    yield* options.clearStoredSession();
    if (!hasEnvironmentSession) return undefined;

    const fallback = yield* Effect.either(options.read());
    if (Either.isRight(fallback)) return fallback.right;
    if (!isTerminalSessionError(fallback.left)) return yield* Effect.fail(fallback.left);
    options.clearEnvironmentSession();
    return undefined;
  });
}
