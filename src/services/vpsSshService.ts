import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const DEFAULT_SSH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const DEFAULT_SSH_BINARY_CANDIDATES = ["ssh", "/usr/bin/ssh", "/bin/ssh", "/usr/local/bin/ssh"];
const DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS = 30;
const DEFAULT_SSH_EXEC_TIMEOUT_MS = 30_000;

export interface VpsSshConfig {
  host: string;
  user: string;
  port: number;
  password?: string;
  privateKeyPath?: string;
  privateKey?: string;
}

export interface VpsSshCommandResult {
  stdout: string;
  stderr: string;
}

function parsePort(portRaw: string | undefined): number {
  if (portRaw === undefined || portRaw.length === 0) {
    return 22;
  }

  const parsedPort = Number.parseInt(portRaw, 10);

  if (!Number.isFinite(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    throw new Error("VPS_SSH_PORT is invalid.");
  }

  return parsedPort;
}

function getSshMaxBufferBytes(): number {
  const rawMaxBuffer = process.env.VPS_SSH_MAX_BUFFER_BYTES;

  if (rawMaxBuffer === undefined || rawMaxBuffer.trim().length === 0) {
    return DEFAULT_SSH_MAX_BUFFER_BYTES;
  }

  const parsedMaxBuffer = Number.parseInt(rawMaxBuffer.trim(), 10);

  if (!Number.isFinite(parsedMaxBuffer) || parsedMaxBuffer < 1024 * 1024) {
    throw new Error("VPS_SSH_MAX_BUFFER_BYTES must be at least 1048576.");
  }

  if (parsedMaxBuffer > 256 * 1024 * 1024) {
    throw new Error("VPS_SSH_MAX_BUFFER_BYTES must be at most 268435456.");
  }

  return parsedMaxBuffer;
}

function getSshConnectTimeoutSeconds(): number {
  const rawValue = process.env.VPS_SSH_CONNECT_TIMEOUT_SECONDS?.trim();

  if (rawValue === undefined || rawValue.length === 0) {
    return DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 120) {
    throw new Error("VPS_SSH_CONNECT_TIMEOUT_SECONDS must be between 1 and 120.");
  }

  return parsed;
}

function getSshExecTimeoutMs(): number {
  const rawValue = process.env.VPS_SSH_EXEC_TIMEOUT_MS?.trim();

  if (rawValue === undefined || rawValue.length === 0) {
    return DEFAULT_SSH_EXEC_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsed) || parsed < 5_000 || parsed > 300_000) {
    throw new Error("VPS_SSH_EXEC_TIMEOUT_MS must be between 5000 and 300000.");
  }

  return parsed;
}

function getSshBinaryCandidates(): string[] {
  const configured = process.env.VPS_SSH_BINARY_PATH?.trim();
  const candidates = [
    configured !== undefined && configured.length > 0 ? configured : null,
    ...DEFAULT_SSH_BINARY_CANDIDATES,
  ].filter((item): item is string => item !== null && item.length > 0);

  return Array.from(new Set(candidates));
}

function isExecutableNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function execSshWithFallback(
  args: string[],
  options: Parameters<typeof execFileAsync>[2],
): Promise<{ stdout: string; stderr: string }> {
  const candidates = getSshBinaryCandidates();
  let missingBinaryCount = 0;

  for (const candidate of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(candidate, args, options);
      return {
        stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8"),
        stderr: typeof stderr === "string" ? stderr : stderr.toString("utf8"),
      };
    } catch (error) {
      if (isExecutableNotFoundError(error)) {
        missingBinaryCount += 1;
        continue;
      }

      throw error;
    }
  }

  if (missingBinaryCount > 0) {
    throw new Error(
      "SSH client is not installed in runtime image. Install openssh-client or set VPS_SSH_BINARY_PATH.",
    );
  }

  throw new Error("Failed to run SSH command: no valid SSH binary candidate.");
}

async function ensureReadablePrivateKey(privateKeyPath: string | undefined): Promise<void> {
  if (privateKeyPath === undefined || privateKeyPath.length === 0) {
    return;
  }

  await access(privateKeyPath, fsConstants.R_OK);
}

function looksLikeInlinePrivateKey(rawValue: string): boolean {
  const trimmed = rawValue.trim();

  if (trimmed.length === 0) {
    return false;
  }

  if (trimmed.includes("BEGIN") && trimmed.includes("PRIVATE KEY")) {
    return true;
  }

  if (trimmed.includes("\n")) {
    return true;
  }

  return false;
}

function looksLikePublicSshKey(rawValue: string): boolean {
  const trimmed = rawValue.trim();
  return /^(ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp)/u.test(trimmed);
}

function normalizeInlinePrivateKey(rawValue: string): string {
  let normalized = rawValue.trim();

  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }

  normalized = normalized.replaceAll("\r", "");
  normalized = normalized.replaceAll("\\n", "\n");

  if (!normalized.endsWith("\n")) {
    normalized += "\n";
  }

  return normalized;
}

function tryDecodeBase64ToPrivateKey(rawValue: string): string | null {
  const trimmed = rawValue.trim();

  if (trimmed.length < 48 || /\s/u.test(trimmed)) {
    return null;
  }

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.includes("BEGIN") && decoded.includes("PRIVATE KEY")) {
      return decoded;
    }
  } catch {
    return null;
  }

  return null;
}

async function validateVpsSshConfig(config: VpsSshConfig): Promise<VpsSshConfig> {
  if (config.host.trim().length === 0) {
    throw new Error("VPS SSH host is not configured.");
  }

  if (config.user.trim().length === 0) {
    throw new Error("VPS SSH user is not configured.");
  }

  if (!Number.isFinite(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error("VPS SSH port is invalid.");
  }

  let privateKeyPath =
    config.privateKeyPath !== undefined && config.privateKeyPath.trim().length > 0
      ? config.privateKeyPath.trim()
      : undefined;
  let privateKey =
    config.privateKey !== undefined && config.privateKey.trim().length > 0
      ? config.privateKey
      : undefined;

  if (privateKeyPath !== undefined && privateKey === undefined) {
    if (looksLikeInlinePrivateKey(privateKeyPath)) {
      privateKey = normalizeInlinePrivateKey(privateKeyPath);
      privateKeyPath = undefined;
    } else if (looksLikePublicSshKey(privateKeyPath)) {
      throw new Error(
        "ssh_connection_key contains a public SSH key. Provide a private key (OpenSSH PEM) or a readable private key path.",
      );
    } else {
      const decodedPrivateKey = tryDecodeBase64ToPrivateKey(privateKeyPath);

      if (decodedPrivateKey !== null) {
        privateKey = normalizeInlinePrivateKey(decodedPrivateKey);
        privateKeyPath = undefined;
      }
    }
  }

  if (privateKey !== undefined) {
    privateKey = normalizeInlinePrivateKey(privateKey);
  }

  if (privateKey !== undefined && looksLikePublicSshKey(privateKey.trim())) {
    throw new Error(
      "ssh_connection_key contains a public SSH key. Provide a private key (OpenSSH PEM).",
    );
  }

  await ensureReadablePrivateKey(privateKeyPath);

  return {
    host: config.host,
    user: config.user,
    port: config.port,
    password:
      config.password !== undefined && config.password.length > 0 ? config.password : undefined,
    privateKeyPath,
    privateKey,
  };
}

async function getVpsSshConfigFromEnv(): Promise<VpsSshConfig> {
  const host = process.env.VPS_SSH_HOST;
  const user = process.env.VPS_SSH_USER;

  if (host === undefined || host.length === 0) {
    throw new Error("VPS_SSH_HOST is not configured.");
  }

  if (user === undefined || user.length === 0) {
    throw new Error("VPS_SSH_USER is not configured.");
  }

  return validateVpsSshConfig({
    host,
    user,
    port: parsePort(process.env.VPS_SSH_PORT),
    password: process.env.VPS_SSH_PASSWORD,
    privateKeyPath: process.env.VPS_SSH_PRIVATE_KEY_PATH,
  });
}

function getBaseSshArgs(config: VpsSshConfig): string[] {
  const connectTimeoutSeconds = getSshConnectTimeoutSeconds();
  const args: string[] = [
    "-p",
    String(config.port),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=" + String(connectTimeoutSeconds),
    "-o",
    "ServerAliveInterval=" + String(connectTimeoutSeconds),
    "-o",
    "ServerAliveCountMax=1",
  ];

  if (config.privateKeyPath !== undefined) {
    args.push("-i", config.privateKeyPath);
  }

  args.push(`${config.user}@${config.host}`);

  return args;
}

async function runSshCommandWithPassword(
  sshArgs: string[],
  password: string,
): Promise<VpsSshCommandResult> {
  const maxBuffer = getSshMaxBufferBytes();
  const execTimeoutMs = getSshExecTimeoutMs();
  const askPassDir = await mkdtemp(join(tmpdir(), "vps-ssh-askpass-"));
  const askPassPath = join(askPassDir, "askpass.sh");

  try {
    await writeFile(
      askPassPath,
      "#!/bin/sh\nprintf '%s\\n' \"$VPS_SSH_ASKPASS_PASSWORD\"\n",
      "utf8",
    );
    await chmod(askPassPath, 0o700);

    const { stdout, stderr } = await execSshWithFallback(sshArgs, {
      timeout: execTimeoutMs,
      maxBuffer,
      env: {
        ...process.env,
        DISPLAY: "localhost:0",
        SSH_ASKPASS: askPassPath,
        SSH_ASKPASS_REQUIRE: "force",
        SSH_AUTH_SOCK: "",
        VPS_SSH_ASKPASS_PASSWORD: password,
      },
    });

    return {
      stdout,
      stderr,
    };
  } finally {
    await rm(askPassDir, { recursive: true, force: true });
  }
}

async function runSshCommandWithConfig(
  config: VpsSshConfig,
  command: string,
): Promise<VpsSshCommandResult> {
  if (command.trim().length === 0) {
    throw new Error("SSH command cannot be empty.");
  }

  const normalizedConfig = await validateVpsSshConfig(config);
  const maxBuffer = getSshMaxBufferBytes();
  const execTimeoutMs = getSshExecTimeoutMs();
  let tempPrivateKeyDir: string | null = null;

  try {
    let configForCommand = normalizedConfig;

    if (
      normalizedConfig.privateKey !== undefined &&
      (normalizedConfig.privateKeyPath === undefined ||
        normalizedConfig.privateKeyPath.length === 0)
    ) {
      tempPrivateKeyDir = await mkdtemp(join(tmpdir(), "vps-ssh-key-"));
      const tempPrivateKeyPath = join(tempPrivateKeyDir, "id_key");
      await writeFile(tempPrivateKeyPath, normalizedConfig.privateKey, "utf8");
      await chmod(tempPrivateKeyPath, 0o600);
      configForCommand = {
        ...normalizedConfig,
        privateKeyPath: tempPrivateKeyPath,
      };
    }

    const sshArgs = [...getBaseSshArgs(configForCommand)];

    if (configForCommand.password !== undefined) {
      return await runSshCommandWithPassword(
        [
          "-o",
          "PubkeyAuthentication=no",
          "-o",
          "PreferredAuthentications=password",
          "-o",
          "NumberOfPasswordPrompts=1",
          ...sshArgs,
          command,
        ],
        configForCommand.password,
      );
    }

    const { stdout, stderr } = await execSshWithFallback([...sshArgs, command], {
      timeout: execTimeoutMs,
      maxBuffer,
    });

    return {
      stdout,
      stderr,
    };
  } finally {
    if (tempPrivateKeyDir !== null) {
      await rm(tempPrivateKeyDir, { recursive: true, force: true });
    }
  }
}

export async function runVpsSshCommandWithConfig(
  config: VpsSshConfig,
  command: string,
): Promise<VpsSshCommandResult> {
  return runSshCommandWithConfig(config, command);
}

export async function runVpsSshCommand(command: string): Promise<VpsSshCommandResult> {
  const config = await getVpsSshConfigFromEnv();
  return runSshCommandWithConfig(config, command);
}
