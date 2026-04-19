export const ANSI_RESET = "\u001b[0m";
export const ANSI_GREEN = "\u001b[32m";
export const ANSI_RED = "\u001b[31m";
/** Truecolor for #ff9800 */
export const ANSI_ORANGE = "\u001b[38;2;255;152;0m";

export function wrapOrange(text: string): string {
  return `${ANSI_ORANGE}${text}${ANSI_RESET}`;
}

export function wrapRed(text: string): string {
  return `${ANSI_RED}${text}${ANSI_RESET}`;
}

/**
 * Like signed PnL color rules, with a `$` after the sign, e.g. `+$12.34 USD` or `+$12.34`.
 */
export function formatSignedUsdWithDollarPrefixColored(usd: number, options: { suffix: string }): string {
  const text =
    usd >= 0
      ? `+$${usd.toFixed(2)}${options.suffix}`
      : `-$${Math.abs(usd).toFixed(2)}${options.suffix}`;
  if (usd < 0) {
    return `${ANSI_RED}${text}${ANSI_RESET}`;
  }
  return `${ANSI_GREEN}${text}${ANSI_RESET}`;
}

/** Green for zero or profit, red for losses. */
export function formatRealizedPnlUsdColored(usd: number): string {
  const text = `${usd.toFixed(2)} USD`;
  if (usd < 0) {
    return `${ANSI_RED}${text}${ANSI_RESET}`;
  }
  return `${ANSI_GREEN}${text}${ANSI_RESET}`;
}

/** Like {@link formatRealizedPnlUsdColored} but with an explicit `+` on zero or profit (e.g. `+0.01 USD`). */
export function formatSignedPnlUsdColored(usd: number): string {
  const sign = usd >= 0 ? "+" : "";
  const text = `${sign}${usd.toFixed(2)} USD`;
  if (usd < 0) {
    return `${ANSI_RED}${text}${ANSI_RESET}`;
  }
  return `${ANSI_GREEN}${text}${ANSI_RESET}`;
}

export function formatConsoleSymbol(symbol: string): string {
  return `$${symbol.toUpperCase()}`;
}

export function formatConsoleLabel(symbol: string): string {
  return `[${ANSI_GREEN}${formatConsoleSymbol(symbol)}${ANSI_RESET}]`;
}

export function formatConsoleSymbolList(symbols: string[]): string {
  return symbols.map(formatConsoleSymbol).join(", ");
}

export function formatConsoleSymbolListGreen(symbols: string[]): string {
  return symbols.map((s) => `${ANSI_GREEN}${formatConsoleSymbol(s)}${ANSI_RESET}`).join(", ");
}

export function formatConsoleTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(new Date(timestamp));
}

/** Local wall time for bot logs, e.g. `01/31/2026 12:01:59 PM` (no comma between date and time). */
export function formatBotCycleTimestamp(date: Date = new Date()): string {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const year = date.getFullYear();
  let hour24 = date.getHours();
  const minute = pad2(date.getMinutes());
  const second = pad2(date.getSeconds());
  const ampm = hour24 >= 12 ? "PM" : "AM";
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return `${month}/${day}/${year} ${hour12}:${minute}:${second} ${ampm}`;
}

export function normalizeConsoleMessage(symbol: string, message: string): string {
  const rawPrefix = `${symbol}:`;
  const formattedPrefix = `${formatConsoleSymbol(symbol)}:`;
  if (message.startsWith(formattedPrefix)) {
    return message.slice(formattedPrefix.length).trimStart();
  }

  if (message.startsWith(rawPrefix)) {
    return message.slice(rawPrefix.length).trimStart();
  }

  return message;
}
