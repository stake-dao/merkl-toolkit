import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAddress, PublicClient, zeroHash } from 'viem';
import { assertCovered } from '../4_check';
import { MERKL_CONTRACT } from '../constants';
import { generateMerkleTree } from '../utils/merkle';
import { campaignReserves, carryUnpublished, MonthlyJournal, readMonthlyJournal, writeMonthlyPublication } from '../utils/monthlyExpiry';

const a = '0x1111111111111111111111111111111111111111';
const t = '0x2222222222222222222222222222222222222222';
const state = { creditedSources: [] } as unknown as MonthlyJournal;
const previous = { sources: ['extra:100'], gains: { [a]: { [t]: '13' } }, allocations: [] };
assert.equal(carryUnpublished(state, { [a]: { [t]: '7' } }, [], 'extra:200', previous).gains[a][t], '20');
state.creditedSources = ['extra:100'];
assert.equal(carryUnpublished(state, { [a]: { [t]: '7' } }, [], 'extra:200', previous).gains[a][t], '7');
assert.throws(() => carryUnpublished(state, {}, [], 'extra:200', { ...previous, sources: ['extra:100', 'extra:150'] }), /partially adopted/);
assert.throws(() => assertCovered(19n, [{ amount: 70n, claimed: 100n }, { amount: 70n, claimed: 50n }], 0n), /Unfunded/);
assert.throws(() => assertCovered(20n, [{ amount: 70n, claimed: 50n }], 1n), /Unfunded/);
assertCovered(21n, [{ amount: 70n, claimed: 50n }], 1n);

async function journalTarget() {
    const original = globalThis.fetch;
    const ledger = { chainId: 1, distributor: getAddress(MERKL_CONTRACT), root: zeroHash };
    const journal = { version: 1, pool: 'extra-1', ledger, merkle: { merkleRoot: zeroHash } };
    try {
        globalThis.fetch = async () => Response.json(journal);
        assert.deepEqual(await readMonthlyJournal(), journal);
        ledger.distributor = MERKL_CONTRACT;
        assert.deepEqual(await readMonthlyJournal(), journal);
        ledger.distributor = t;
        await assert.rejects(readMonthlyJournal(), /target mismatch/);
        ledger.distributor = MERKL_CONTRACT;
        ledger.chainId = 10;
        await assert.rejects(readMonthlyJournal(), /target mismatch/);
    } finally { globalThis.fetch = original; }
}

function ordinaryProofs(directory: string) {
    const candidate = { version: 1, pool: 'extra-1', revision: 1, kind: 'ordinary', parent: zeroHash,
        merkle: generateMerkleTree({ [a]: { [t]: '13' }, [t]: { [t]: '17' } }), gains: {}, allocations: [],
        sources: ['extra:100'], reserves: {}, campaignCount: '2', checkpoint: { block: 100, blockHash: zeroHash }, ipfsHash: zeroHash };
    writeMonthlyPublication(candidate, directory);
    const file = path.join(directory, 'monthly-expiry/roots', `${candidate.merkle.merkleRoot.toLowerCase()}.json`);
    const envelope = path.join(directory, 'last_publication.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), candidate.merkle);
    assert.deepEqual(JSON.parse(fs.readFileSync(envelope, 'utf8')).merkle, candidate.merkle);
    writeMonthlyPublication(candidate, directory); // Retry is harmless.
    const next = { ...candidate, merkle: generateMerkleTree({ [a]: { [t]: '27' } }) };
    writeMonthlyPublication(next, directory);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), candidate.merkle); // Old active proofs remain available.
    fs.writeFileSync(file, '{}');
    assert.throws(() => writeMonthlyPublication(candidate, directory), /conflicting proofs/);
    assert.deepEqual(JSON.parse(fs.readFileSync(envelope, 'utf8')), next);
}

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monthly-reserves-'));
    try {
        await journalTarget();
        ordinaryProofs(directory);
        fs.mkdirSync(path.join(directory, '100'));
        const write = (amount: string, declared = amount) => fs.writeFileSync(path.join(directory, '100/distribution.json'), JSON.stringify({ timestamp: 100, blockNumber: 100,
            incentives: [{ token: { address: t }, distribution: { incentiveId: 0, amountToDistribute: declared }, users: [{ user: a, amount }] }] }));
        write('13');
        // An untracked campaign is still reserved, not free balance.
        const client = { readContract: async () => 2n, multicall: async () => [[a, t, 0n, 0n, 0n, 1n, a, 50n], [a, t, 0n, 0n, 0n, 1n, a, 17n]] } as unknown as PublicClient;
        assert.deepEqual(await campaignReserves(client, 100n, directory), { reserves: { [t]: '54' }, campaignCount: '2' });
        write('51');
        await assert.rejects(campaignReserves(client, 100n, directory), /campaign 0 allocations exceed funding by 1/);
        write('13', '12');
        await assert.rejects(campaignReserves(client, 100n, directory), /allocation sum mismatch/);
        console.log('PASS: journal address and chain; immutable ordinary proofs; unpublished gains, liabilities, unallocated campaigns, strict deficits and archive sums');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
