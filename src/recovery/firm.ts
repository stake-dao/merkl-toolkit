import { getAddress } from "viem";
import type { Distribution, IncentiveDistribution } from "../interfaces/Distribution";
import type { MerkleData } from "../interfaces/MerkleData";
import type { UniversalMerkle } from "../interfaces/UniversalMerkle";
import type { SerializedEarnedEntry } from "../interfaces/Breakdown";
import { generateMerkleTree } from "../utils/merkle";

// The only DOLA/swanUSD distribution credited to this FiRM escrow before borrower routing.
export const FIRM_RECOVERY = {
    parentRoot: "0x82a64ef5a697cf29bf5a620865c58a599c3ee3c361c5508dec55dd2a555b17cf",
    timestamp: 1795456871,
    blockNumber: 26479491,
    incentiveId: 2601,
    vault: getAddress("0xfb77f231D8006A5da17503aa3EF38bFd2092453F"),
    token: getAddress("0x865377367054516e17014CcdED1e7d814EDC9ce4"),
    escrow: getAddress("0x4b460cf00679cd0291048c75ca4c63d3ae830630"),
    beneficiary: getAddress("0x80c67fe70d7d6cc488782439fad381d8646640c4"),
    amount: 36666666666666441888n,
} as const;

function recoveryIncentive(distribution: Distribution): IncentiveDistribution {
    const r = FIRM_RECOVERY;
    const matches = distribution.incentives.filter(entry => entry.distribution.incentiveId === r.incentiveId);
    if (distribution.timestamp !== r.timestamp || distribution.blockNumber !== r.blockNumber || matches.length !== 1) {
        throw new Error("FiRM recovery cannot identify the unique historical distribution for incentive 2601");
    }
    const entry = matches[0];
    if (getAddress(entry.vault) !== r.vault || getAddress(entry.token.address) !== r.token ||
        entry.token.decimals !== 18 || BigInt(entry.distribution.amountToDistribute) !== r.amount ||
        entry.users.length !== 1 || BigInt(entry.users[0].amount) !== r.amount) {
        throw new Error("FiRM recovery historical vault, token or allocation mismatch");
    }
    const user = entry.users[0];
    const account = getAddress(user.user);
    if (account === r.escrow && (user.source === undefined || user.source === "direct") && !user.firmEscrows?.length) return entry;
    if (account !== r.beneficiary || user.source !== "firm" || user.firmEscrows?.length !== 1 ||
        getAddress(user.firmEscrows[0].escrow) !== r.escrow || BigInt(user.firmEscrows[0].amount) !== r.amount) {
        throw new Error("FiRM recovery historical recipient or provenance mismatch");
    }
    return entry;
}

export function repairFirmDistribution(distribution: Distribution): Distribution {
    const affected = recoveryIncentive(distribution);
    const user = affected.users[0];
    if (getAddress(user.user) === FIRM_RECOVERY.beneficiary) return distribution;
    return {
        ...distribution,
        incentives: distribution.incentives.map(entry => entry === affected ? {
            ...entry,
            users: [{
                ...user,
                user: FIRM_RECOVERY.beneficiary,
                source: "firm",
                firmEscrows: [{ escrow: FIRM_RECOVERY.escrow, amount: FIRM_RECOVERY.amount.toString() }],
            }],
        } : entry),
    };
}

/** Migrate the already-indexed earning without replaying unrelated reward and claim history. */
export function repairFirmEarned(entries: Record<string, SerializedEarnedEntry[]>, lastProcessedTimestamp: number) {
    const r = FIRM_RECOVERY;
    if (lastProcessedTimestamp < r.timestamp) return entries;

    const keyFor = (account: string) => {
        const canonical = `${account}-${r.token}`;
        const matches = Object.keys(entries).filter(key => key.toLowerCase() === canonical.toLowerCase());
        if (matches.length > 1) throw new Error("FiRM recovery earned cache contains duplicate account keys");
        return matches[0] ?? canonical;
    };
    const escrowKey = keyFor(r.escrow);
    const borrowerKey = keyFor(r.beneficiary);
    const isWindow = (row: SerializedEarnedEntry) => row.timestamp === r.timestamp && getAddress(row.vault) === r.vault;
    const source = (entries[escrowKey] ?? []).filter(isWindow);
    const destination = (entries[borrowerKey] ?? []).filter(isWindow);

    if (source.length === 0 && destination.length === 1 &&
        destination[0].source === "firm" && BigInt(destination[0].amount) === r.amount) return entries;
    if (source.length !== 1 || destination.length !== 0 ||
        source[0].source !== "direct" || BigInt(source[0].amount) !== r.amount) {
        throw new Error("FiRM recovery earned cache is missing or has an ambiguous historical allocation");
    }

    const repaired = { ...entries };
    const remaining = entries[escrowKey].filter(row => row !== source[0]);
    if (remaining.length) repaired[escrowKey] = remaining;
    else delete repaired[escrowKey];
    const credit: SerializedEarnedEntry = { ...source[0], source: "firm" };
    repaired[borrowerKey] = [...(entries[borrowerKey] ?? []), credit]
        .sort((a, b) => a.timestamp - b.timestamp);
    return repaired;
}

/** Correct the historical FiRM recipient on its exact published parent before adding new rewards. */
export function reassignFirmBalance(original: MerkleData, history: Distribution, claimed: bigint): MerkleData {
    const { parentRoot, token, escrow, beneficiary, amount } = FIRM_RECOVERY;
    if (original.merkleRoot !== parentRoot) throw new Error("FiRM recovery requires its original published root");
    if (claimed !== 0n) throw new Error("FiRM escrow DOLA has already been claimed");
    recoveryIncentive(history);

    const balances: UniversalMerkle = {};
    for (const [account, claim] of Object.entries(original.claims)) {
        const user = getAddress(account);
        if (balances[user]) throw new Error("Duplicate account in FiRM recovery source tree");
        balances[user] = {};
        for (const [address, leaf] of Object.entries(claim.tokens)) {
            const reward = getAddress(address);
            if (reward in balances[user]) throw new Error("Duplicate token in FiRM recovery source tree");
            balances[user][reward] = BigInt(leaf.amount).toString();
        }
    }
    if (generateMerkleTree(balances).merkleRoot !== parentRoot) {
        throw new Error("FiRM recovery source root does not match its claims");
    }

    const escrowAmount = balances[escrow]?.[token];
    if (escrowAmount === undefined || BigInt(escrowAmount) !== amount) {
        throw new Error("FiRM recovery escrow cumulative DOLA differs from the historical allocation");
    }

    delete balances[escrow][token];
    if (Object.keys(balances[escrow]).length === 0) delete balances[escrow];
    balances[beneficiary] ??= {};
    balances[beneficiary][token] = (BigInt(balances[beneficiary][token] ?? "0") + amount).toString();
    return generateMerkleTree(balances);
}
