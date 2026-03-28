export function formatConsoleSymbol(symbol: string): string {
  return `$${symbol.toUpperCase()}`;
}

export function formatConsoleLabel(symbol: string): string {
  return `[${formatConsoleSymbol(symbol)}]`;
}

export function formatConsoleSymbolList(symbols: string[]): string {
  return symbols.map(formatConsoleSymbol).join(", ");
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
