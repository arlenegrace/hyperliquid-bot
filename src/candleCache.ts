import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Candle } from "./types.js";

const MAX_CANDLES_PER_SYMBOL = 500;

interface CandleCacheFile {
  updatedAt: number;
  symbols: Record<string, Candle[]>;
}

function resolveCachePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

export async function loadCandleCache(filePath: string): Promise<Map<string, Candle[]>> {
  const absolutePath = resolveCachePath(filePath);
  try {
    const rawFile = await readFile(absolutePath, "utf8");
    const parsed = JSON.parse(rawFile) as CandleCacheFile;
    const result = new Map<string, Candle[]>();
    for (const [symbol, candles] of Object.entries(parsed.symbols ?? {})) {
      if (Array.isArray(candles)) {
        result.set(symbol.toUpperCase(), candles);
      }
    }
    return result;
  } catch {
    return new Map();
  }
}

export async function saveCandleCache(
  filePath: string,
  candlesBySymbol: Map<string, Candle[]>,
): Promise<void> {
  const absolutePath = resolveCachePath(filePath);
  const symbols: Record<string, Candle[]> = {};
  for (const [symbol, candles] of candlesBySymbol.entries()) {
    symbols[symbol.toUpperCase()] = candles.slice(-MAX_CANDLES_PER_SYMBOL);
  }

  const payload: CandleCacheFile = {
    updatedAt: Date.now(),
    symbols,
  };

  try {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${JSON.stringify(payload)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[candle-cache] Failed to persist candle cache to ${absolutePath}: ${message}`);
  }
}
