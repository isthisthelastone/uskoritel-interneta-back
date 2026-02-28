const suspiciousCommandPattern =
  /\b(?:id|user_id|chat_id|admin_id|target_id|uid)\s*[:=]\s*\d+\b|tg:\/\/user\?id=|\b\d{8,}\b/iu;

export interface ParsedTelegramCommand {
  command: string | null;
  argument: string | null;
  isSuspicious: boolean;
  reason?: string;
}

export function getTelegramCommand(
  text: string | undefined,
  botUsername: string | undefined,
): ParsedTelegramCommand {
  if (text === undefined) {
    return {
      command: null,
      argument: null,
      isSuspicious: false,
    };
  }

  const normalizedText = text.trim();

  if (!normalizedText.startsWith("/")) {
    return {
      command: null,
      argument: null,
      isSuspicious: false,
    };
  }

  if (normalizedText.length > 128) {
    return {
      command: null,
      argument: null,
      isSuspicious: true,
      reason: "Potential ID injection payload detected.",
    };
  }

  const tokens = normalizedText.split(/\s+/u).filter((token) => token.length > 0);
  const firstToken = tokens[0] ?? "";
  const commandMatch = /^\/([a-z_]+)(?:@([a-z0-9_]{3,}))?$/iu.exec(firstToken);

  if (commandMatch === null) {
    return {
      command: null,
      argument: null,
      isSuspicious: true,
      reason: "Malformed Telegram command.",
    };
  }

  if (tokens.length > 2) {
    return {
      command: null,
      argument: null,
      isSuspicious: true,
      reason: "Too many command arguments.",
    };
  }

  const botMention = commandMatch.at(2)?.toLowerCase() ?? "";
  const expectedBotUsername = (botUsername ?? "").replace(/^@/u, "").toLowerCase();

  if (
    botMention.length > 0 &&
    expectedBotUsername.length > 0 &&
    botMention !== expectedBotUsername
  ) {
    return {
      command: null,
      argument: null,
      isSuspicious: false,
      reason: "Command is addressed to a different bot.",
    };
  }

  const normalizedCommand = "/" + commandMatch[1].toLowerCase();
  const argument = tokens.length === 2 ? tokens[1] : null;

  if (argument !== null) {
    if (normalizedCommand !== "/start") {
      return {
        command: null,
        argument: null,
        isSuspicious: true,
        reason: "Command arguments are blocked for security.",
      };
    }

    if (!/^ref_[1-9]\d{0,19}$/u.test(argument)) {
      return {
        command: null,
        argument: null,
        isSuspicious: true,
        reason: "Unsupported /start payload.",
      };
    }
  } else if (suspiciousCommandPattern.test(normalizedText)) {
    return {
      command: null,
      argument: null,
      isSuspicious: true,
      reason: "Potential ID injection payload detected.",
    };
  }

  return {
    command: normalizedCommand,
    argument,
    isSuspicious: false,
  };
}
