const suspiciousCommandPattern =
  /\b(?:id|user_id|chat_id|admin_id|target_id|uid)\s*[:=]\s*\d+\b|tg:\/\/user\?id=|\b\d{8,}\b/iu;

export interface ParsedTelegramCommand {
  command: string | null;
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
      isSuspicious: false,
    };
  }

  const normalizedText = text.trim();

  if (!normalizedText.startsWith("/")) {
    return {
      command: null,
      isSuspicious: false,
    };
  }

  if (normalizedText.length > 64 || suspiciousCommandPattern.test(normalizedText)) {
    return {
      command: null,
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
      isSuspicious: true,
      reason: "Malformed Telegram command.",
    };
  }

  if (tokens.length > 1) {
    return {
      command: null,
      isSuspicious: true,
      reason: "Command arguments are blocked for security.",
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
      isSuspicious: false,
      reason: "Command is addressed to a different bot.",
    };
  }

  return {
    command: "/" + commandMatch[1].toLowerCase(),
    isSuspicious: false,
  };
}
