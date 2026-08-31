export interface EnableBankingCredentials {
  appId: string;
  privateKey: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadCredentials(
  env: NodeJS.ProcessEnv = process.env,
): EnableBankingCredentials {
  const appId =
    env.ENABLE_BANKING_APP_ID?.trim() || env.ENABLE_BANKING_ID?.trim();
  if (!appId) {
    throw new Error(
      "Missing required environment variable: ENABLE_BANKING_ID or ENABLE_BANKING_APP_ID",
    );
  }
  return {
    appId,
    privateKey: required(env, "ENABLE_BANKING_PRIVATE_KEY"),
  };
}
