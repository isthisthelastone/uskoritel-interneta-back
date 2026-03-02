import { randomBytes } from "node:crypto";
import { z } from "zod";
import { runVpsSshCommandWithConfig, type VpsSshConfig } from "./vpsSshService";

const DEFAULT_XRAY_CONFIG_PATH = "/etc/xray/config.json";
const DEFAULT_XRAY_DIRECT_TAG = "trojan-direct";
const DEFAULT_XRAY_OBFS_TAG = "trojan-obfs";

interface EnsureVpsTrojanClientInput {
  sshConfig: VpsSshConfig;
  userInternalUuid: string;
  password: string;
}

type JsonObject = Record<string, unknown>;

interface XrayConfigDocument extends JsonObject {
  inbounds: JsonObject[];
}

const xrayConfigDocumentSchema = z
  .object({
    inbounds: z.array(z.record(z.string(), z.unknown())),
  })
  .loose();

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function getXrayRuntimeConfig(): {
  configPath: string;
  directTag: string;
  obfsTag: string;
} {
  const configPath = process.env.XRAY_CONFIG_PATH?.trim() || DEFAULT_XRAY_CONFIG_PATH;
  const directTag = process.env.XRAY_TROJAN_DIRECT_TAG?.trim() || DEFAULT_XRAY_DIRECT_TAG;
  const obfsTag = process.env.XRAY_TROJAN_OBFS_TAG?.trim() || DEFAULT_XRAY_OBFS_TAG;

  return {
    configPath,
    directTag,
    obfsTag,
  };
}

function parseXrayConfig(rawConfig: string): XrayConfigDocument {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(rawConfig);
  } catch {
    throw new Error("Failed to parse remote Xray config JSON.");
  }

  const parsed = xrayConfigDocumentSchema.parse(parsedJson);
  return parsed as XrayConfigDocument;
}

function getInboundClients(inbound: JsonObject, inboundTag: string): JsonObject[] {
  const protocol = inbound.protocol;

  if (protocol !== "trojan") {
    throw new Error("Xray inbound " + inboundTag + " must use trojan protocol.");
  }

  const settingsRaw = inbound.settings;

  if (typeof settingsRaw !== "object" || settingsRaw === null || Array.isArray(settingsRaw)) {
    throw new Error("Xray inbound " + inboundTag + " has invalid settings object.");
  }

  const settings = settingsRaw as JsonObject;
  const clientsRaw = settings.clients;

  if (!Array.isArray(clientsRaw)) {
    throw new Error("Xray inbound " + inboundTag + " has no settings.clients array.");
  }

  const clients: JsonObject[] = [];

  for (const client of clientsRaw) {
    if (typeof client === "object" && client !== null && !Array.isArray(client)) {
      clients.push(client as JsonObject);
    }
  }

  settings.clients = clients;
  return clients;
}

function upsertTrojanClientByEmail(
  config: XrayConfigDocument,
  inboundTag: string,
  userInternalUuid: string,
  password: string,
): boolean {
  const inbound = config.inbounds.find(
    (item) => typeof item.tag === "string" && item.tag === inboundTag,
  );

  if (inbound === undefined) {
    throw new Error("Xray inbound tag is missing: " + inboundTag);
  }

  const clients = getInboundClients(inbound, inboundTag);
  const existingIndex = clients.findIndex((client) => client.email === userInternalUuid);

  if (existingIndex === -1) {
    clients.push({
      email: userInternalUuid,
      password,
    });
    return true;
  }

  const existingClient = clients[existingIndex];

  if (existingClient.password === password && existingClient.email === userInternalUuid) {
    return false;
  }

  clients[existingIndex] = {
    ...existingClient,
    email: userInternalUuid,
    password,
  };

  return true;
}

async function readRemoteXrayConfig(
  sshConfig: VpsSshConfig,
  configPath: string,
): Promise<XrayConfigDocument> {
  const readResult = await runVpsSshCommandWithConfig(sshConfig, "cat " + shellQuote(configPath));
  return parseXrayConfig(readResult.stdout);
}

async function writeRemoteXrayConfig(
  sshConfig: VpsSshConfig,
  configPath: string,
  nextConfig: XrayConfigDocument,
): Promise<void> {
  const tempPath = "/tmp/xray-config-" + randomBytes(8).toString("hex") + ".json";
  const base64Payload = Buffer.from(JSON.stringify(nextConfig, null, 2), "utf8").toString("base64");

  const command =
    "set -eu; " +
    "tmp_path=" +
    shellQuote(tempPath) +
    "; " +
    "config_path=" +
    shellQuote(configPath) +
    "; " +
    "printf %s " +
    shellQuote(base64Payload) +
    ' | base64 -d > "$tmp_path"; ' +
    'if command -v xray >/dev/null 2>&1; then xray -test -config "$tmp_path"; fi; ' +
    'cp "$tmp_path" "$config_path"; ' +
    'rm -f "$tmp_path"; ' +
    "if command -v systemctl >/dev/null 2>&1; then " +
    "systemctl reload xray || systemctl restart xray; " +
    "elif command -v service >/dev/null 2>&1; then " +
    "service xray reload || service xray restart; " +
    "else " +
    "pkill -HUP xray || true; " +
    "fi";

  await runVpsSshCommandWithConfig(sshConfig, command);
}

export async function ensureVpsTrojanClient(input: EnsureVpsTrojanClientInput): Promise<boolean> {
  const runtimeConfig = getXrayRuntimeConfig();
  const xrayConfig = await readRemoteXrayConfig(input.sshConfig, runtimeConfig.configPath);
  const directChanged = upsertTrojanClientByEmail(
    xrayConfig,
    runtimeConfig.directTag,
    input.userInternalUuid,
    input.password,
  );
  const obfsChanged = upsertTrojanClientByEmail(
    xrayConfig,
    runtimeConfig.obfsTag,
    input.userInternalUuid,
    input.password,
  );

  if (!directChanged && !obfsChanged) {
    return false;
  }

  await writeRemoteXrayConfig(input.sshConfig, runtimeConfig.configPath, xrayConfig);
  return true;
}
