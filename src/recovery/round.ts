import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Distribution } from "../interfaces/Distribution";
import type { DistributionData } from "../interfaces/DistributionData";
import { safeStringify } from "../utils/parse";

export const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8"));

export function write(file: string, value: unknown) {
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
        fs.writeFileSync(temporary, safeStringify(value));
        fs.renameSync(temporary, file);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

/** A recovery can run even when distribute() produced no ordinary window. */
export function openEmptyRound(dir: string, index: DistributionData[], block: { timestamp: bigint; number: bigint }): DistributionData {
    const last = index[index.length - 1];
    const timestamp = Number(block.timestamp);
    const blockNumber = Number(block.number);
    if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(blockNumber) ||
        timestamp <= last.timestamp || blockNumber <= last.blockNumber) {
        throw new Error("Recovery requires a newer block for its empty distribution");
    }

    const folder = path.join(dir, "distributions", String(timestamp));
    const file = path.join(folder, "distribution.json");
    if (fs.existsSync(file)) {
        const existing = read<Distribution>(file);
        if (existing.timestamp !== timestamp || existing.blockNumber !== blockNumber || existing.incentives.length !== 0) {
            throw new Error("Conflicting distribution at the recovery timestamp");
        }
    } else {
        fs.mkdirSync(folder, { recursive: true });
        write(file, { blockNumber, timestamp, incentives: [] });
    }
    const round = { timestamp, blockNumber, sentOnchain: false };
    index.push(round);
    write(path.join(dir, "distribution.json"), index);
    return round;
}
