export type LoopbackRedirect = {
  protocol: "https:";
  hostname: string;
  port: number;
  path: string;
};

const LOOPBACK_HOSTS: Record<string, true> = {
  "127.0.0.1": true,
  localhost: true,
};

export function parseLoopbackRedirect(value: string): LoopbackRedirect {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("redirect_url must be a valid URL");
  }
  if (
    url.protocol !== "https:" ||
    !Object.hasOwn(LOOPBACK_HOSTS, url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.port
  ) {
    throw new Error(
      "redirect_url must be an https:// localhost or 127.0.0.1 URL with an explicit port and no query parameters",
    );
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("redirect_url must include a valid TCP port");
  }
  return {
    protocol: "https:",
    hostname: url.hostname,
    port,
    path: url.pathname || "/",
  };
}
