import { randomBytes } from "node:crypto";
import { z } from "zod";
import { runVpsSshCommandWithConfig, type VpsSshConfig } from "./vpsSshService";

const DEFAULT_XRAY_CONFIG_PATH = "/etc/xray/config.json";
const DEFAULT_XRAY_DIRECT_TAG = "trojan-direct";
const DEFAULT_XRAY_OBFS_TAG = "trojan-obfs";
const DEFAULT_XRAY_VLESS_WS_TAG = "vless-ws";
const DEFAULT_XRAY_SHADOWSOCKS_TAG = "shadowsocks";
const DEFAULT_XRAY_SHADOWSOCKS_METHOD = "aes-256-gcm";
const vpsClientProtocolSchema = z.enum(["trojan", "trojan_obfuscated", "vless_ws", "shadowsocks"]);

export type VpsClientProtocol = z.infer<typeof vpsClientProtocolSchema>;

interface EnsureVpsTrojanClientInput {
  sshConfig: VpsSshConfig;
  userInternalUuid: string;
  password: string;
}

interface RemoveVpsTrojanClientInput {
  sshConfig: VpsSshConfig;
  userInternalUuid: string;
}

interface EnsureVpsClientInput {
  sshConfig: VpsSshConfig;
  userInternalUuid: string;
  protocol: VpsClientProtocol;
  secret: string;
}

interface RemoveVpsClientInput {
  sshConfig: VpsSshConfig;
  userInternalUuid: string;
  protocol: VpsClientProtocol;
}

interface RemoveVpsUserFromAllProtocolsInput {
  sshConfig: VpsSshConfig;
  userInternalUuid: string;
  trojanPasswords?: string[];
}

interface BackfillVpsXrayUserClientsFromUsersKvMapInput {
  sshConfig: VpsSshConfig;
  usersKvMap: unknown;
  onlyUsers?: string[];
}

export interface BackfillVpsXrayUserClientsFromUsersKvMapResult {
  changed: boolean;
  touchedUsers: number;
  touchedCredentials: number;
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

function decodeBase64Strict(rawValue: string): string | null {
  try {
    const decoded = Buffer.from(rawValue, "base64").toString("utf8").trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function parseProtocolSecretFromConfigUrl(
  configUrl: string,
): { protocol: VpsClientProtocol; secret: string } | null {
  try {
    const parsed = new URL(configUrl);
    const scheme = parsed.protocol.toLowerCase();

    if (scheme === "trojan:") {
      const secret = decodeURIComponent(parsed.username).trim();

      if (secret.length === 0) {
        return null;
      }

      const fragment = decodeURIComponent(parsed.hash.slice(1)).toLowerCase();
      const isObfs =
        fragment.includes("obfs") ||
        fragment.includes("trojan_obfuscated") ||
        fragment.includes("trojan-obfuscated");

      return {
        protocol: isObfs ? "trojan_obfuscated" : "trojan",
        secret,
      };
    }

    if (scheme === "vless:") {
      const secret = decodeURIComponent(parsed.username).trim();

      if (secret.length === 0) {
        return null;
      }

      return {
        protocol: "vless_ws",
        secret,
      };
    }

    if (scheme === "ss:") {
      if (parsed.password.length > 0) {
        const secret = decodeURIComponent(parsed.password).trim();

        if (secret.length === 0) {
          return null;
        }

        return {
          protocol: "shadowsocks",
          secret,
        };
      }

      const rawUsername = decodeURIComponent(parsed.username).trim();
      const decodedUsername = decodeBase64Strict(rawUsername);
      const usernameCandidate = decodedUsername ?? rawUsername;
      const separatorIndex = usernameCandidate.indexOf(":");

      if (separatorIndex > -1 && separatorIndex < usernameCandidate.length - 1) {
        const secret = usernameCandidate.slice(separatorIndex + 1).trim();

        if (secret.length > 0) {
          return {
            protocol: "shadowsocks",
            secret,
          };
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

function parseUsersKvMapProtocolSecrets(
  usersKvMap: unknown,
): Map<string, Partial<Record<VpsClientProtocol, string>>> {
  const result = new Map<string, Partial<Record<VpsClientProtocol, string>>>();

  if (typeof usersKvMap !== "object" || usersKvMap === null || Array.isArray(usersKvMap)) {
    return result;
  }

  const usersMap = usersKvMap as Record<string, unknown>;
  const uuidPattern =
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu;

  for (const [rawUserUuid, rawEntry] of Object.entries(usersMap)) {
    const uuidMatch = rawUserUuid.match(uuidPattern);

    if (uuidMatch === null) {
      continue;
    }

    const userInternalUuid = uuidMatch[0].toLowerCase();
    const protocolSecrets: Partial<Record<VpsClientProtocol, string>> = {};

    if (typeof rawEntry === "object" && rawEntry !== null && !Array.isArray(rawEntry)) {
      const entry = rawEntry as Record<string, unknown>;
      const protocolsRaw = entry.protocols;

      if (
        typeof protocolsRaw === "object" &&
        protocolsRaw !== null &&
        !Array.isArray(protocolsRaw)
      ) {
        const protocols = protocolsRaw as Record<string, unknown>;

        for (const protocol of vpsClientProtocolSchema.options) {
          const protocolRaw = protocols[protocol];

          if (
            typeof protocolRaw !== "object" ||
            protocolRaw === null ||
            Array.isArray(protocolRaw)
          ) {
            continue;
          }

          const protocolEntry = protocolRaw as Record<string, unknown>;
          const secretBase64 = protocolEntry.secretBase64;

          if (typeof secretBase64 === "string") {
            const decoded = decodeBase64Strict(secretBase64);

            if (decoded !== null && decoded.length > 0) {
              protocolSecrets[protocol] = decoded;
              continue;
            }
          }

          const protocolUrl = protocolEntry.url;

          if (typeof protocolUrl === "string") {
            const parsedFromUrl = parseProtocolSecretFromConfigUrl(protocolUrl);

            if (parsedFromUrl !== null && parsedFromUrl.protocol === protocol) {
              protocolSecrets[protocol] = parsedFromUrl.secret;
            }
          }
        }
      }

      if (protocolSecrets.trojan === undefined || protocolSecrets.trojan_obfuscated === undefined) {
        const legacyPasswordBase64 = entry.passwordBase64;
        const decodedLegacyPassword =
          typeof legacyPasswordBase64 === "string"
            ? decodeBase64Strict(legacyPasswordBase64)
            : null;

        if (decodedLegacyPassword !== null && decodedLegacyPassword.length > 0) {
          if (protocolSecrets.trojan === undefined && typeof entry.directUrl === "string") {
            protocolSecrets.trojan = decodedLegacyPassword;
          }

          if (
            protocolSecrets.trojan_obfuscated === undefined &&
            typeof entry.obfsUrl === "string"
          ) {
            protocolSecrets.trojan_obfuscated = decodedLegacyPassword;
          }
        }
      }

      for (const rawValue of Object.values(entry)) {
        if (typeof rawValue !== "string") {
          continue;
        }

        const parsedFromUrl = parseProtocolSecretFromConfigUrl(rawValue);

        if (parsedFromUrl === null || parsedFromUrl.secret.length === 0) {
          continue;
        }

        if (protocolSecrets[parsedFromUrl.protocol] === undefined) {
          protocolSecrets[parsedFromUrl.protocol] = parsedFromUrl.secret;
        }
      }
    }

    if (Object.keys(protocolSecrets).length === 0) {
      continue;
    }

    result.set(userInternalUuid, protocolSecrets);
  }

  return result;
}

function getXrayRuntimeConfig(): {
  configPath: string;
  directTag: string;
  obfsTag: string;
  vlessWsTag: string;
  shadowsocksTag: string;
  shadowsocksMethod: string;
} {
  const configPath = process.env.XRAY_CONFIG_PATH?.trim() || DEFAULT_XRAY_CONFIG_PATH;
  const directTag = process.env.XRAY_TROJAN_DIRECT_TAG?.trim() || DEFAULT_XRAY_DIRECT_TAG;
  const obfsTag = process.env.XRAY_TROJAN_OBFS_TAG?.trim() || DEFAULT_XRAY_OBFS_TAG;
  const vlessWsTag = process.env.XRAY_VLESS_WS_TAG?.trim() || DEFAULT_XRAY_VLESS_WS_TAG;
  const shadowsocksTag = process.env.XRAY_SHADOWSOCKS_TAG?.trim() || DEFAULT_XRAY_SHADOWSOCKS_TAG;
  const shadowsocksMethod =
    process.env.XRAY_SHADOWSOCKS_METHOD?.trim() || DEFAULT_XRAY_SHADOWSOCKS_METHOD;

  return {
    configPath,
    directTag,
    obfsTag,
    vlessWsTag,
    shadowsocksTag,
    shadowsocksMethod,
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

function getInboundByTag(
  config: XrayConfigDocument,
  inboundTag: string,
  required: boolean,
): JsonObject | null {
  const inbound = config.inbounds.find(
    (item) => typeof item.tag === "string" && item.tag === inboundTag,
  );

  if (inbound === undefined) {
    if (required) {
      throw new Error("Xray inbound tag is missing: " + inboundTag);
    }

    return null;
  }

  return inbound;
}

function getInboundTagValue(inbound: JsonObject): string | null {
  const rawTag = inbound.tag;
  return typeof rawTag === "string" && rawTag.trim().length > 0 ? rawTag : null;
}

function getInboundStreamNetwork(inbound: JsonObject): string | null {
  const streamSettingsRaw = inbound.streamSettings;

  if (
    typeof streamSettingsRaw !== "object" ||
    streamSettingsRaw === null ||
    Array.isArray(streamSettingsRaw)
  ) {
    return null;
  }

  const networkRaw = (streamSettingsRaw as JsonObject).network;
  return typeof networkRaw === "string" && networkRaw.trim().length > 0
    ? networkRaw.trim().toLowerCase()
    : null;
}

function resolveInboundForProtocol(input: {
  config: XrayConfigDocument;
  runtimeConfig: ReturnType<typeof getXrayRuntimeConfig>;
  protocol: VpsClientProtocol;
  required: boolean;
}): { inbound: JsonObject; inboundTag: string } | null {
  const expectedTag = getInboundTagByProtocol(input.runtimeConfig, input.protocol);
  const byExpectedTag = getInboundByTag(input.config, expectedTag, false);

  if (byExpectedTag !== null) {
    return {
      inbound: byExpectedTag,
      inboundTag: expectedTag,
    };
  }

  if (input.protocol === "vless_ws") {
    const vlessInbounds = input.config.inbounds.filter((item) => item.protocol === "vless");

    if (vlessInbounds.length > 0) {
      const inbound =
        vlessInbounds.find((item) => getInboundStreamNetwork(item) === "ws") ?? vlessInbounds[0];
      return {
        inbound,
        inboundTag: getInboundTagValue(inbound) ?? expectedTag,
      };
    }
  }

  if (input.protocol === "shadowsocks") {
    const shadowsocksInbound = input.config.inbounds.find(
      (item) => item.protocol === "shadowsocks",
    );

    if (shadowsocksInbound !== undefined) {
      const inbound = shadowsocksInbound;
      return {
        inbound,
        inboundTag: getInboundTagValue(inbound) ?? expectedTag,
      };
    }
  }

  if (!input.required) {
    return null;
  }

  throw new Error("Xray inbound tag is missing: " + expectedTag);
}

function getInboundSettings(inbound: JsonObject, inboundTag: string): JsonObject {
  const settingsRaw = inbound.settings;

  if (typeof settingsRaw !== "object" || settingsRaw === null || Array.isArray(settingsRaw)) {
    throw new Error("Xray inbound " + inboundTag + " has invalid settings object.");
  }

  return settingsRaw as JsonObject;
}

function getTrojanInboundClients(inbound: JsonObject, inboundTag: string): JsonObject[] {
  const protocol = inbound.protocol;

  if (protocol !== "trojan") {
    throw new Error("Xray inbound " + inboundTag + " must use trojan protocol.");
  }

  const settings = getInboundSettings(inbound, inboundTag);
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

function getVlessInboundClients(inbound: JsonObject, inboundTag: string): JsonObject[] {
  const protocol = inbound.protocol;

  if (protocol !== "vless") {
    throw new Error("Xray inbound " + inboundTag + " must use vless protocol.");
  }

  const settings = getInboundSettings(inbound, inboundTag);
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

function getShadowsocksInboundClients(inbound: JsonObject, inboundTag: string): JsonObject[] {
  const protocol = inbound.protocol;

  if (protocol !== "shadowsocks") {
    throw new Error("Xray inbound " + inboundTag + " must use shadowsocks protocol.");
  }

  const settings = getInboundSettings(inbound, inboundTag);
  const clientsRaw = settings.clients;

  if (!Array.isArray(clientsRaw)) {
    throw new Error(
      "Xray inbound " +
        inboundTag +
        " has no settings.clients array. Configure shadowsocks multi-user clients first.",
    );
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

function upsertTrojanClientByEmail(input: {
  inbound: JsonObject;
  inboundTag: string;
  userInternalUuid: string;
  password: string;
}): boolean {
  const clients = getTrojanInboundClients(input.inbound, input.inboundTag);
  const existingIndex = clients.findIndex((client) => {
    if (client.email === input.userInternalUuid) {
      return true;
    }

    return typeof client.password === "string" && client.password === input.password;
  });

  if (existingIndex === -1) {
    clients.push({
      email: input.userInternalUuid,
      password: input.password,
    });
    return true;
  }

  const existingClient = clients[existingIndex];

  if (
    existingClient.password === input.password &&
    existingClient.email === input.userInternalUuid
  ) {
    return false;
  }

  clients[existingIndex] = {
    ...existingClient,
    email: input.userInternalUuid,
    password: input.password,
  };

  return true;
}

function upsertVlessClient(input: {
  inbound: JsonObject;
  inboundTag: string;
  userInternalUuid: string;
  clientId: string;
}): boolean {
  const clients = getVlessInboundClients(input.inbound, input.inboundTag);
  const existingIndex = clients.findIndex(
    (client) =>
      client.email === input.userInternalUuid ||
      client.id === input.clientId ||
      client.id === input.userInternalUuid,
  );

  if (existingIndex === -1) {
    clients.push({
      id: input.clientId,
      email: input.userInternalUuid,
    });
    return true;
  }

  const existingClient = clients[existingIndex];

  if (existingClient.id === input.clientId && existingClient.email === input.userInternalUuid) {
    return false;
  }

  clients[existingIndex] = {
    ...existingClient,
    id: input.clientId,
    email: input.userInternalUuid,
  };

  return true;
}

function upsertShadowsocksClient(input: {
  inbound: JsonObject;
  inboundTag: string;
  userInternalUuid: string;
  password: string;
  defaultMethod: string;
}): boolean {
  const settings = getInboundSettings(input.inbound, input.inboundTag);
  const clients = getShadowsocksInboundClients(input.inbound, input.inboundTag);
  const existingIndex = clients.findIndex((client) => {
    if (client.email === input.userInternalUuid) {
      return true;
    }

    return typeof client.password === "string" && client.password === input.password;
  });
  const methodFromSettings =
    typeof settings.method === "string" && settings.method.trim().length > 0
      ? settings.method
      : input.defaultMethod;

  if (existingIndex === -1) {
    clients.push({
      email: input.userInternalUuid,
      password: input.password,
      method: methodFromSettings,
    });
    return true;
  }

  const existingClient = clients[existingIndex];
  const method =
    typeof existingClient.method === "string" && existingClient.method.length > 0
      ? existingClient.method
      : methodFromSettings;

  if (
    existingClient.email === input.userInternalUuid &&
    existingClient.password === input.password &&
    method === existingClient.method
  ) {
    return false;
  }

  clients[existingIndex] = {
    ...existingClient,
    email: input.userInternalUuid,
    password: input.password,
    method,
  };

  return true;
}

function removeTrojanClient(input: {
  inbound: JsonObject;
  inboundTag: string;
  userInternalUuid: string;
  trojanPasswords?: string[];
}): boolean {
  const clients = getTrojanInboundClients(input.inbound, input.inboundTag);
  const initialLength = clients.length;
  const passwordSet = new Set(
    (input.trojanPasswords ?? []).map((item) => item.trim()).filter((item) => item.length > 0),
  );
  const nextClients = clients.filter((client) => {
    if (client.email === input.userInternalUuid) {
      return false;
    }

    if (passwordSet.size === 0 || typeof client.password !== "string") {
      return true;
    }

    return !passwordSet.has(client.password);
  });

  if (nextClients.length === initialLength) {
    return false;
  }

  const settings = getInboundSettings(input.inbound, input.inboundTag);
  settings.clients = nextClients;
  return true;
}

function removeVlessClient(input: {
  inbound: JsonObject;
  inboundTag: string;
  userInternalUuid: string;
}): boolean {
  const clients = getVlessInboundClients(input.inbound, input.inboundTag);
  const initialLength = clients.length;
  const nextClients = clients.filter(
    (client) => client.email !== input.userInternalUuid && client.id !== input.userInternalUuid,
  );

  if (nextClients.length === initialLength) {
    return false;
  }

  const settings = getInboundSettings(input.inbound, input.inboundTag);
  settings.clients = nextClients;
  return true;
}

function removeShadowsocksClient(input: {
  inbound: JsonObject;
  inboundTag: string;
  userInternalUuid: string;
}): boolean {
  const clients = getShadowsocksInboundClients(input.inbound, input.inboundTag);
  const initialLength = clients.length;
  const nextClients = clients.filter((client) => client.email !== input.userInternalUuid);

  if (nextClients.length === initialLength) {
    return false;
  }

  const settings = getInboundSettings(input.inbound, input.inboundTag);
  settings.clients = nextClients;
  return true;
}

async function readRemoteXrayConfig(
  sshConfig: VpsSshConfig,
  configPath: string,
): Promise<XrayConfigDocument> {
  const readResult = await runVpsSshCommandWithConfig(
    sshConfig,
    "set -eu; " +
      "config_path=" +
      shellQuote(configPath) +
      "; " +
      "if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then " +
      'sudo -n cat "$config_path"; ' +
      "else " +
      'cat "$config_path"; ' +
      "fi",
  );
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
    "if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then " +
    "SUDO='sudo -n'; " +
    "else " +
    "SUDO=''; " +
    "fi; " +
    'if command -v xray >/dev/null 2>&1; then $SUDO xray -test -config "$tmp_path"; fi; ' +
    '$SUDO cp "$tmp_path" "$config_path"; ' +
    'rm -f "$tmp_path"; ' +
    "if command -v systemctl >/dev/null 2>&1; then " +
    "$SUDO systemctl reload xray || $SUDO systemctl restart xray; " +
    "elif command -v service >/dev/null 2>&1; then " +
    "$SUDO service xray reload || $SUDO service xray restart; " +
    "else " +
    "$SUDO pkill -HUP xray || true; " +
    "fi";

  await runVpsSshCommandWithConfig(sshConfig, command);
}

function getInboundTagByProtocol(
  runtimeConfig: ReturnType<typeof getXrayRuntimeConfig>,
  protocol: VpsClientProtocol,
): string {
  if (protocol === "trojan") {
    return runtimeConfig.directTag;
  }

  if (protocol === "trojan_obfuscated") {
    return runtimeConfig.obfsTag;
  }

  if (protocol === "vless_ws") {
    return runtimeConfig.vlessWsTag;
  }

  return runtimeConfig.shadowsocksTag;
}

export async function ensureVpsXrayClient(input: EnsureVpsClientInput): Promise<boolean> {
  const parsedProtocol = vpsClientProtocolSchema.parse(input.protocol);
  const runtimeConfig = getXrayRuntimeConfig();
  const xrayConfig = await readRemoteXrayConfig(input.sshConfig, runtimeConfig.configPath);
  const inboundTarget = resolveInboundForProtocol({
    config: xrayConfig,
    runtimeConfig,
    protocol: parsedProtocol,
    required: true,
  });

  if (inboundTarget === null) {
    throw new Error("Xray inbound resolution failed for protocol: " + parsedProtocol);
  }

  const inboundTag = inboundTarget.inboundTag;
  const inbound = inboundTarget.inbound;

  let changed = false;

  if (parsedProtocol === "trojan" || parsedProtocol === "trojan_obfuscated") {
    changed = upsertTrojanClientByEmail({
      inbound,
      inboundTag,
      userInternalUuid: input.userInternalUuid,
      password: input.secret,
    });
  } else if (parsedProtocol === "vless_ws") {
    const parsedClientId = z.uuid().safeParse(input.secret);

    if (!parsedClientId.success) {
      throw new Error("VLESS client id must be a valid UUID.");
    }

    changed = upsertVlessClient({
      inbound,
      inboundTag,
      userInternalUuid: input.userInternalUuid,
      clientId: parsedClientId.data,
    });
  } else {
    changed = upsertShadowsocksClient({
      inbound,
      inboundTag,
      userInternalUuid: input.userInternalUuid,
      password: input.secret,
      defaultMethod: runtimeConfig.shadowsocksMethod,
    });
  }

  if (!changed) {
    return false;
  }

  await writeRemoteXrayConfig(input.sshConfig, runtimeConfig.configPath, xrayConfig);
  return true;
}

export async function removeVpsXrayClient(input: RemoveVpsClientInput): Promise<boolean> {
  const parsedProtocol = vpsClientProtocolSchema.parse(input.protocol);
  const runtimeConfig = getXrayRuntimeConfig();
  const xrayConfig = await readRemoteXrayConfig(input.sshConfig, runtimeConfig.configPath);
  const inboundTarget = resolveInboundForProtocol({
    config: xrayConfig,
    runtimeConfig,
    protocol: parsedProtocol,
    required: false,
  });

  if (inboundTarget === null) {
    return false;
  }
  const inboundTag = inboundTarget.inboundTag;
  const inbound = inboundTarget.inbound;

  let changed = false;

  if (parsedProtocol === "trojan" || parsedProtocol === "trojan_obfuscated") {
    changed = removeTrojanClient({
      inbound,
      inboundTag,
      userInternalUuid: input.userInternalUuid,
    });
  } else if (parsedProtocol === "vless_ws") {
    changed = removeVlessClient({
      inbound,
      inboundTag,
      userInternalUuid: input.userInternalUuid,
    });
  } else {
    changed = removeShadowsocksClient({
      inbound,
      inboundTag,
      userInternalUuid: input.userInternalUuid,
    });
  }

  if (!changed) {
    return false;
  }

  await writeRemoteXrayConfig(input.sshConfig, runtimeConfig.configPath, xrayConfig);
  return true;
}

export async function removeVpsXrayUserFromAllProtocols(
  input: RemoveVpsUserFromAllProtocolsInput,
): Promise<boolean> {
  const runtimeConfig = getXrayRuntimeConfig();
  const xrayConfig = await readRemoteXrayConfig(input.sshConfig, runtimeConfig.configPath);
  const candidates: Array<{
    protocol: VpsClientProtocol;
    inbound: JsonObject;
    inboundTag: string;
  }> = [];

  for (let index = 0; index < xrayConfig.inbounds.length; index += 1) {
    const inbound = xrayConfig.inbounds[index];
    const protocolRaw = inbound.protocol;
    const inboundTag = getInboundTagValue(inbound) ?? "inbound-" + String(index + 1);

    if (protocolRaw === "trojan") {
      candidates.push({
        protocol: "trojan",
        inbound,
        inboundTag,
      });
      continue;
    }

    if (protocolRaw === "vless") {
      candidates.push({
        protocol: "vless_ws",
        inbound,
        inboundTag,
      });
      continue;
    }

    if (protocolRaw === "shadowsocks") {
      candidates.push({
        protocol: "shadowsocks",
        inbound,
        inboundTag,
      });
    }
  }

  let changed = false;

  for (const candidate of candidates) {
    try {
      let currentChanged = false;

      if (candidate.protocol === "trojan") {
        currentChanged = removeTrojanClient({
          inbound: candidate.inbound,
          inboundTag: candidate.inboundTag,
          userInternalUuid: input.userInternalUuid,
          trojanPasswords: input.trojanPasswords,
        });
      } else if (candidate.protocol === "vless_ws") {
        currentChanged = removeVlessClient({
          inbound: candidate.inbound,
          inboundTag: candidate.inboundTag,
          userInternalUuid: input.userInternalUuid,
        });
      } else {
        currentChanged = removeShadowsocksClient({
          inbound: candidate.inbound,
          inboundTag: candidate.inboundTag,
          userInternalUuid: input.userInternalUuid,
        });
      }

      if (currentChanged) {
        changed = true;
      }
    } catch {
      continue;
    }
  }

  if (!changed) {
    return false;
  }

  await writeRemoteXrayConfig(input.sshConfig, runtimeConfig.configPath, xrayConfig);
  return true;
}

export async function backfillVpsXrayUserClientsFromUsersKvMap(
  input: BackfillVpsXrayUserClientsFromUsersKvMapInput,
): Promise<BackfillVpsXrayUserClientsFromUsersKvMapResult> {
  const runtimeConfig = getXrayRuntimeConfig();
  const xrayConfig = await readRemoteXrayConfig(input.sshConfig, runtimeConfig.configPath);
  const usersProtocolSecrets = parseUsersKvMapProtocolSecrets(input.usersKvMap);

  if (usersProtocolSecrets.size === 0) {
    return {
      changed: false,
      touchedUsers: 0,
      touchedCredentials: 0,
    };
  }

  const onlyUsersSet =
    input.onlyUsers !== undefined && input.onlyUsers.length > 0
      ? new Set(input.onlyUsers.map((user) => user.toLowerCase()))
      : null;
  const inboundTargets: Partial<
    Record<VpsClientProtocol, { inbound: JsonObject; inboundTag: string }>
  > = {};

  for (const protocol of vpsClientProtocolSchema.options) {
    const inboundTarget = resolveInboundForProtocol({
      config: xrayConfig,
      runtimeConfig,
      protocol,
      required: false,
    });

    if (inboundTarget !== null) {
      inboundTargets[protocol] = inboundTarget;
    }
  }

  let changed = false;
  let touchedUsers = 0;
  let touchedCredentials = 0;

  for (const [userInternalUuid, protocolSecrets] of usersProtocolSecrets.entries()) {
    if (onlyUsersSet !== null && !onlyUsersSet.has(userInternalUuid)) {
      continue;
    }

    let touchedUser = false;

    for (const protocol of vpsClientProtocolSchema.options) {
      const secret = protocolSecrets[protocol];

      if (secret === undefined || secret.trim().length === 0) {
        continue;
      }

      const inboundTarget = inboundTargets[protocol];

      if (inboundTarget === undefined) {
        continue;
      }

      let currentChanged = false;

      if (protocol === "trojan" || protocol === "trojan_obfuscated") {
        currentChanged = upsertTrojanClientByEmail({
          inbound: inboundTarget.inbound,
          inboundTag: inboundTarget.inboundTag,
          userInternalUuid,
          password: secret,
        });
      } else if (protocol === "vless_ws") {
        const parsedClientId = z.uuid().safeParse(secret);

        if (!parsedClientId.success) {
          continue;
        }

        currentChanged = upsertVlessClient({
          inbound: inboundTarget.inbound,
          inboundTag: inboundTarget.inboundTag,
          userInternalUuid,
          clientId: parsedClientId.data,
        });
      } else {
        currentChanged = upsertShadowsocksClient({
          inbound: inboundTarget.inbound,
          inboundTag: inboundTarget.inboundTag,
          userInternalUuid,
          password: secret,
          defaultMethod: runtimeConfig.shadowsocksMethod,
        });
      }

      touchedCredentials += 1;

      if (currentChanged) {
        changed = true;
        touchedUser = true;
      }
    }

    if (touchedUser) {
      touchedUsers += 1;
    }
  }

  if (changed) {
    await writeRemoteXrayConfig(input.sshConfig, runtimeConfig.configPath, xrayConfig);
  }

  return {
    changed,
    touchedUsers,
    touchedCredentials,
  };
}

export async function ensureVpsTrojanClient(input: EnsureVpsTrojanClientInput): Promise<boolean> {
  const directChanged = await ensureVpsXrayClient({
    sshConfig: input.sshConfig,
    userInternalUuid: input.userInternalUuid,
    protocol: "trojan",
    secret: input.password,
  });
  const obfsChanged = await ensureVpsXrayClient({
    sshConfig: input.sshConfig,
    userInternalUuid: input.userInternalUuid,
    protocol: "trojan_obfuscated",
    secret: input.password,
  });

  return directChanged || obfsChanged;
}

export async function removeVpsTrojanClient(input: RemoveVpsTrojanClientInput): Promise<boolean> {
  const directChanged = await removeVpsXrayClient({
    sshConfig: input.sshConfig,
    userInternalUuid: input.userInternalUuid,
    protocol: "trojan",
  });
  const obfsChanged = await removeVpsXrayClient({
    sshConfig: input.sshConfig,
    userInternalUuid: input.userInternalUuid,
    protocol: "trojan_obfuscated",
  });

  return directChanged || obfsChanged;
}
