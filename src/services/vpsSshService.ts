import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface VpsSshConfig {
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

async function getVpsSshConfig(): Promise<VpsSshConfig> {
  const host = process.env.VPS_SSH_HOST;
  const user = process.env.VPS_SSH_USER;
  const password = process.env.VPS_SSH_PASSWORD;
  const privateKeyPath = process.env.VPS_SSH_PRIVATE_KEY_PATH;

  if (host === undefined || host.length === 0) {
    throw new Error("VPS_SSH_HOST is not configured.");
  }

  if (user === undefined || user.length === 0) {
    throw new Error("VPS_SSH_USER is not configured.");
  }

  if (privateKeyPath !== undefined && privateKeyPath.length > 0) {
    await access(privateKeyPath, fsConstants.R_OK);
  }

  return {
    host,
    user,
    port: parsePort(process.env.VPS_SSH_PORT),
    password: password !== undefined && password.length > 0 ? password : undefined,
    privateKeyPath:
      privateKeyPath !== undefined && privateKeyPath.length > 0 ? privateKeyPath : undefined,
  };
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

export async function runVpsSshCommand(command: string): Promise<VpsSshCommandResult> {
  if (command.trim().length === 0) {
    throw new Error("SSH command cannot be empty.");
  }

  const config = await getVpsSshConfig();
  const sshArgs = [...getBaseSshArgs(config), command];

  if (config.password !== undefined) {
    try {
      const { stdout, stderr } = await execFileAsync(
        "sshpass",
        ["-p", config.password, "ssh", ...sshArgs],
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
