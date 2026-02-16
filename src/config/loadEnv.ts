import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_FILE_PATH = resolve(process.cwd(), "src/config/.env");
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeEnvValue(rawValue: string): string {
  const trimmedValue = rawValue.trim();

  if (
    (trimmedValue.startsWith('"') && trimmedValue.endsWith('"')) ||
    (trimmedValue.startsWith("'") && trimmedValue.endsWith("'"))
  ) {
    return trimmedValue.slice(1, -1);
  }

  return trimmedValue;
}

export function loadEnvFromConfigFile(): void {
  if (!existsSync(ENV_FILE_PATH)) {
    return;
  }

  const fileContents = readFileSync(ENV_FILE_PATH, "utf8");
  const lines = fileContents.split(/\r?\n/u);

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();

    if (!ENV_KEY_PATTERN.test(key)) {
      continue;
    }

    const value = normalizeEnvValue(trimmedLine.slice(separatorIndex + 1));

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
