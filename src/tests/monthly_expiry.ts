import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublicClient } from 'viem';
import { assertCovered } from '../4_check';
import { campaignReserves, carryUnpublished, MonthlyJournal } from '../utils/monthlyExpiry';

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

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monthly-reserves-'));
    try {
        fs.mkdirSync(path.join(directory, '100'));
        fs.writeFileSync(path.join(directory, '100/distribution.json'), JSON.stringify({ incentives: [{ token: { address: t }, distribution: { incentiveId: 0 }, users: [{ user: a, amount: '13' }] }] }));
        // An untracked campaign is still reserved, not free balance.
        const client = { readContract: async () => 2n, multicall: async () => [[a, t, 0n, 0n, 0n, 1n, a, 50n], [a, t, 0n, 0n, 0n, 1n, a, 17n]] } as unknown as PublicClient;
        assert.deepEqual(await campaignReserves(client, 100n, directory), { reserves: { [t]: '54' }, campaignCount: '2' });
        fs.writeFileSync(path.join(directory, '100/distribution.json'), JSON.stringify({ incentives: [{ token: { address: t }, distribution: { incentiveId: 0 }, users: [{ user: a, amount: '51' }] }] }));
        await assert.rejects(campaignReserves(client, 100n, directory), /exceed funding/);
        console.log('PASS: unpublished gains retained once; positive liabilities and all campaign commitments remain covered');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
