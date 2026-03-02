import { randomBytes } from "node:crypto";
import { xrayConfigSchema, type XrayConfig } from "../shared";
import { runVpsSshCommandWithConfig, type VpsSshConfig } from "./vpsSshService";

const DEFAULT_XRAY_CONFIG_PATH = "/etc/xray/config.json";
const DEFAULT_XRAY_DIRECT_TAG = "trojan-direct";
const DEFAULT_XRAY_OBFS_TAG = "trojan-obfs";

interface EnsureVpsTrojanClientInput {
  sshConfig: VpsSshConfig;
  userInternalUuid: string;
  password: string;
}

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

function parseXrayConfig(rawConfig: string): XrayConfig {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(rawConfig);
  } catch {
    throw new Error("Failed to parse remote Xray config JSON.");
  }

  return xrayConfigSchema.parse(parsedJson);
}

function upsertTrojanClientByEmail(
  config: XrayConfig,
  inboundTag: string,
  userInternalUuid: string,
  password: string,
): boolean {
  const inbound = config.inbounds.find((item) => item.tag === inboundTag);

  if (inbound === undefined) {
    throw new Error("Xray inbound tag is missing: " + inboundTag);
  }

  const existingIndex = inbound.settings.clients.findIndex(
    (client) => client.email === userInternalUuid,
  );

  if (existingIndex === -1) {
    inbound.settings.clients.push({
      email: userInternalUuid,
      password,
    });
    return true;
  }

  const existingClient = inbound.settings.clients[existingIndex];

  if (existingClient.password === password && existingClient.email === userInternalUuid) {
    return false;
  }

  inbound.settings.clients[existingIndex] = {
    ...existingClient,
    email: userInternalUuid,
    password,
  };

  return true;
}

async function readRemoteXrayConfig(
  sshConfig: VpsSshConfig,
  configPath: string,
): Promise<XrayConfig> {
  const readResult = await runVpsSshCommandWithConfig(sshConfig, "cat " + shellQuote(configPath));
  return parseXrayConfig(readResult.stdout);
}

async function writeRemoteXrayConfig(
  sshConfig: VpsSshConfig,
  configPath: string,
  nextConfig: XrayConfig,
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
