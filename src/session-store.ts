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

function runSecurity(args: string[]): Promise<SecurityResult> {
  const { promise, resolve, reject } = Promise.withResolvers<SecurityResult>();
  const child = spawn(SECURITY_COMMAND, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

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

export class MacKeychainSecretStore implements SecretStore {
  constructor(
    private readonly service: string,
    private readonly account = DEFAULT_ACCOUNT,
    private readonly label = "secret",
  ) {}

  async get(): Promise<string | undefined> {
    const result = await runSecurity([
      "find-generic-password",
      "-a",
      this.account,
      "-s",
      this.service,
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
    const value = result.stdout.trim();
    return value || undefined;
  }

  async set(value: string): Promise<void> {
    const normalized = value.trim();
    if (!normalized) {
      throw new Error(`Cannot store an empty Enable Banking ${this.label}`);
    }
    const result = await runSecurity([
      "add-generic-password",
      "-a",
      this.account,
      "-s",
      this.service,
      "-U",
      "-T",
      SECURITY_COMMAND,
      "-X",
      Buffer.from(normalized, "utf8").toString("hex"),
    ]);
    if (result.code !== 0) {
      throw new Error(`Unable to store the Enable Banking ${this.label} in Keychain`);
    }
  }

  async clear(): Promise<void> {
    const result = await runSecurity([
      "delete-generic-password",
      "-a",
      this.account,
      "-s",
      this.service,
    ]);
    if (
      result.code !== 0 &&
      result.code !== 44 &&
      !/specified item could not be found/i.test(result.stderr)
    ) {
      throw new Error(`Unable to clear the Enable Banking ${this.label} from Keychain`);
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
