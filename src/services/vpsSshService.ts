import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const DEFAULT_SSH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

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
      privateKey = privateKeyPath;
      privateKeyPath = undefined;
    } else if (looksLikePublicSshKey(privateKeyPath)) {
      throw new Error(
        "ssh_connection_key contains a public SSH key. Provide a private key (OpenSSH PEM) or a readable private key path.",
      );
    } else {
      const decodedPrivateKey = tryDecodeBase64ToPrivateKey(privateKeyPath);

      if (decodedPrivateKey !== null) {
        privateKey = decodedPrivateKey;
        privateKeyPath = undefined;
      }
    }
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
  const args: string[] = [
    "-p",
    String(config.port),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ServerAliveInterval=8",
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
  const askPassDir = await mkdtemp(join(tmpdir(), "vps-ssh-askpass-"));
  const askPassPath = join(askPassDir, "askpass.sh");

  try {
    await writeFile(
      askPassPath,
      "#!/bin/sh\nprintf '%s\\n' \"$VPS_SSH_ASKPASS_PASSWORD\"\n",
      "utf8",
    );
    await chmod(askPassPath, 0o700);

    const { stdout, stderr } = await execFileAsync("ssh", sshArgs, {
      timeout: 20_000,
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

    const { stdout, stderr } = await execFileAsync("ssh", [...sshArgs, command], {
      timeout: 20_000,
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
