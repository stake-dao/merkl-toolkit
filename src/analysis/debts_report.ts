import { readFileSync } from "fs";
import { join } from "path";
import { getAddress, formatUnits } from "viem";
import { getClient } from "../utils/rpc";

const erc20Abi = [
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

type DebtsFile = Record<string, Record<string, string>>;

interface TokenAgg {
  holders: number;
  total: bigint;
}

function loadDebts(filename: string): DebtsFile {
  const raw = readFileSync(join(__dirname, "../../data", filename), "utf-8");
  return JSON.parse(raw);
}

function aggregate(debts: DebtsFile): Map<string, TokenAgg> {
  const map = new Map<string, TokenAgg>();
  for (const tokens of Object.values(debts)) {
    for (const [token, amount] of Object.entries(tokens)) {
      const key = getAddress(token);
      const prev = map.get(key) ?? { holders: 0, total: 0n };
      map.set(key, { holders: prev.holders + 1, total: prev.total + BigInt(amount) });
    }
  }
  return map;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

async function main() {
  const initialDebts = loadDebts("initial_debts.json");
  const currentDebts = loadDebts("debts.json");

  const initialAgg = aggregate(initialDebts);
  const currentAgg = aggregate(currentDebts);

  // Collect all unique token addresses
  const allTokens = [...new Set([...initialAgg.keys(), ...currentAgg.keys()])];

  // Fetch decimals and symbols via multicall
  const client = await getClient(1);
  const calls = allTokens.flatMap((addr) => [
    { address: addr as `0x${string}`, abi: erc20Abi, functionName: "decimals" as const },
    { address: addr as `0x${string}`, abi: erc20Abi, functionName: "symbol" as const },
  ]);

  const results = await client.multicall({ contracts: calls });

  const tokenMeta = new Map<string, { decimals: number; symbol: string }>();
  for (let i = 0; i < allTokens.length; i++) {
    const decimals = (results[i * 2] as any).result as number;
    const symbol = (results[i * 2 + 1] as any).result as string;
    tokenMeta.set(allTokens[i], { decimals, symbol });
  }

  // Print report
  const sep = "═".repeat(50);
  const dash = "─".repeat(50);

  console.log(`\n${sep}`);
  console.log("            DEBT REPORT — Mainnet");
  console.log(sep);

  const printSection = (title: string, agg: Map<string, TokenAgg>) => {
    console.log(`\n${dash}`);
    console.log(`  ${title}`);
    console.log(dash);
    for (const [token, { holders, total }] of agg) {
      const meta = tokenMeta.get(token)!;
      const formatted = formatUnits(total, meta.decimals);
      const num = Number(formatted).toLocaleString("en-US", { maximumFractionDigits: meta.decimals });
      console.log(`\n  ${meta.symbol} (${shortAddr(token)})`);
      console.log(`    Holders: ${holders} | Total: ${num} ${meta.symbol}`);
    }
  };

  printSection("INITIAL DEBTS (initial_debts.json)", initialAgg);
  printSection("CURRENT DEBTS (debts.json)", currentAgg);

  // Delta
  console.log(`\n${dash}`);
  console.log("  DELTA (repaid = initial - current)");
  console.log(dash);

  for (const token of allTokens) {
    const meta = tokenMeta.get(token)!;
    const init = initialAgg.get(token)?.total ?? 0n;
    const curr = currentAgg.get(token)?.total ?? 0n;
    const delta = init - curr;
    const formatted = formatUnits(delta, meta.decimals);
    const num = Number(formatted).toLocaleString("en-US", { maximumFractionDigits: meta.decimals });
    const label = delta >= 0n ? "repaid" : "increased";
    console.log(`\n  ${meta.symbol}: ${num} ${label}`);
  }

  console.log(`\n${sep}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
