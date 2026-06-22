import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const execFileAsync = promisify(execFile);

const SYMBOLS = process.argv.slice(2);
if (SYMBOLS.length === 0) {
  SYMBOLS.push("BTCUSDT");
}

const INTERVAL = "4h";
const BASE_URL = "https://data.binance.vision/data/spot/monthly/klines";
const ANALYSIS_DIR = path.resolve(import.meta.dirname, "..", "analysis");
const RAW_DIR = path.join(ANALYSIS_DIR, "raw");

const CSV_HEADER =
  "open_time,open,high,low,close,volume,close_time,quote_volume,trade_count,taker_buy_base_volume,taker_buy_quote_volume,ignore";

interface MonthSpec {
  year: number;
  month: number;
}

function generateMonths(startYear: number, startMonth: number): MonthSpec[] {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const months: MonthSpec[] = [];

  for (let year = startYear; year <= currentYear; year++) {
    const fromMonth = year === startYear ? startMonth : 1;
    const toMonth = year === currentYear ? currentMonth : 12;
    for (let month = fromMonth; month <= toMonth; month++) {
      months.push({ year, month });
    }
  }

  return months;
}

async function downloadFile(url: string, destPath: string): Promise<boolean> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    return false;
  }

  const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  const fileStream = createWriteStream(destPath);
  await pipeline(nodeStream, fileStream);
  return true;
}

async function extractZip(zipPath: string, outDir: string): Promise<boolean> {
  try {
    await execFileAsync("unzip", ["-o", "-qq", zipPath, "-d", outDir]);
    return true;
  } catch {
    try {
      await execFileAsync("tar", ["-xf", zipPath, "-C", outDir]);
      return true;
    } catch {
      return false;
    }
  }
}

function getListingDate(symbol: string): { year: number; month: number } {
  const dates: Record<string, { year: number; month: number }> = {
    BTCUSDT: { year: 2017, month: 8 },
    ETHUSDT: { year: 2017, month: 8 },
    BNBUSDT: { year: 2017, month: 11 },
    XRPUSDT: { year: 2018, month: 5 },
    SOLUSDT: { year: 2020, month: 8 },
    DOGEUSDT: { year: 2019, month: 7 },
    ADAUSDT: { year: 2018, month: 4 },
    AVAXUSDT: { year: 2020, month: 9 },
    AAVEUSDT: { year: 2020, month: 10 },
    CRVUSDT: { year: 2020, month: 8 },
    DYDXUSDT: { year: 2021, month: 9 },
  };
  return dates[symbol] ?? { year: 2017, month: 1 };
}

async function downloadSymbol(symbol: string): Promise<void> {
  const symbolRawDir = path.join(RAW_DIR, symbol);
  await mkdir(symbolRawDir, { recursive: true });

  const listingDate = getListingDate(symbol);
  const months = generateMonths(listingDate.year, listingDate.month);

  console.log(`\n[${symbol}] Downloading ${months.length} months of ${INTERVAL} klines...\n`);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const { year, month } of months) {
    const monthStr = String(month).padStart(2, "0");
    const fileName = `${symbol}-${INTERVAL}-${year}-${monthStr}`;
    const zipPath = path.join(symbolRawDir, `${fileName}.zip`);
    const url = `${BASE_URL}/${symbol}/${INTERVAL}/${fileName}.zip`;

    process.stdout.write(`  ${fileName} ... `);

    const ok = await downloadFile(url, zipPath);
    if (!ok) {
      console.log("not available (skipped)");
      skipped++;
      continue;
    }

    const extracted = await extractZip(zipPath, symbolRawDir);
    if (!extracted) {
      console.log("extraction failed");
      failed++;
      continue;
    }

    await rm(zipPath, { force: true });
    downloaded++;
    console.log("ok");
  }

  console.log(`\n  Downloaded: ${downloaded} | Skipped: ${skipped} | Failed: ${failed}`);

  console.log(`  Merging CSVs...`);
  await mergeCsvFiles(symbol, symbolRawDir);
}

async function mergeCsvFiles(symbol: string, dir: string): Promise<void> {
  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".csv"))
    .sort();

  const outPath = path.join(ANALYSIS_DIR, `${symbol}_${INTERVAL}.csv`);
  const outStream = createWriteStream(outPath);
  outStream.write(CSV_HEADER + "\n");

  let totalLines = 0;

  for (const file of files) {
    const filePath = path.join(dir, file);
    const content = await readFile(filePath, "utf8");
    const lines = content.trim().split("\n");

    for (const line of lines) {
      if (line.trim() && !line.startsWith("open_time")) {
        outStream.write(line.trimEnd() + "\n");
        totalLines++;
      }
    }
  }

  outStream.end();
  await new Promise<void>((resolve) => outStream.on("finish", resolve));

  console.log(`  Wrote ${totalLines.toLocaleString()} candles to ${path.relative(process.cwd(), outPath)}`);
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });

  console.log("Binance Historical Kline Downloader");
  console.log(`Symbols: ${SYMBOLS.join(", ")}`);
  console.log(`Interval: ${INTERVAL}`);
  console.log(`Output: ${ANALYSIS_DIR}/\n`);

  for (const symbol of SYMBOLS) {
    await downloadSymbol(symbol);
  }

  console.log("\nDone.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
