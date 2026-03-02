import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface VpsSshConfig {
  host: string;
  user: string;
  port: number;
  password?: string;
  privateKeyPath?: string;
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

async function ensureReadablePrivateKey(privateKeyPath: string | undefined): Promise<void> {
  if (privateKeyPath === undefined || privateKeyPath.length === 0) {
    return;
  }

  await access(privateKeyPath, fsConstants.R_OK);
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

  await ensureReadablePrivateKey(config.privateKeyPath);

  return {
    host: config.host,
    user: config.user,
    port: config.port,
    password:
      config.password !== undefined && config.password.length > 0 ? config.password : undefined,
    privateKeyPath:
      config.privateKeyPath !== undefined && config.privateKeyPath.length > 0
        ? config.privateKeyPath
        : undefined,
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

async function runSshCommandWithConfig(
  config: VpsSshConfig,
  command: string,
): Promise<VpsSshCommandResult> {
  if (command.trim().length === 0) {
    throw new Error("SSH command cannot be empty.");
  }

  const normalizedConfig = await validateVpsSshConfig(config);
  const sshArgs = [...getBaseSshArgs(normalizedConfig), command];

  if (normalizedConfig.password !== undefined) {
    try {
      const { stdout, stderr } = await execFileAsync(
        "sshpass",
        ["-p", normalizedConfig.password, "ssh", ...sshArgs],
        {
          timeout: 20_000,
          maxBuffer: 1024 * 1024,
        },
      );

      return {
        stdout,
        stderr,
      };
    } catch (error) {
      const typedError = error as NodeJS.ErrnoException;

      if (typedError.code === "ENOENT") {
        throw new Error(
          "sshpass is not installed. Install sshpass or set VPS_SSH_PRIVATE_KEY_PATH for key-based auth.",
        );
      }

      throw error;
    }
  }

  const { stdout, stderr } = await execFileAsync("ssh", sshArgs, {
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });

  return {
    stdout,
    stderr,
  };
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
