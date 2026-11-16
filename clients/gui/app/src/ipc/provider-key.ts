import { HostClient } from "@areal/client/node";

/** Main 只绑定可信桌面来源；供应商选择、版本核对和凭据读取归 Host。 */
export async function revealProviderKey(
  options: {
    home: string;
    binary: string;
    profile: string;
    trusted(): unknown;
  },
  request: Record<string, unknown>,
) {
  options.trusted();
  const client = new HostClient();
  try {
    await client.connectOrStart(options.home, options.binary);
    const value = await client.request("providers.revealKey", {
      profile: options.profile,
      expectedGeneration: client.generation,
      id: request.id,
      expectedRevision: request.expectedRevision,
    });
    options.trusted();
    if (
      !value ||
      typeof value !== "object" ||
      !("apiKey" in value) ||
      typeof value.apiKey !== "string" ||
      !value.apiKey ||
      value.apiKey.length > 16384
    )
      throw new Error("Invalid provider key response");
    return { apiKey: value.apiKey };
  } finally {
    client.close();
  }
}
