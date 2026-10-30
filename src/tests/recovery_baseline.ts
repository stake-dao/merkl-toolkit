import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCombineDistribution, generateMerkleTree, resolveRecoveryBaseline } from '../utils/merkle';
import { Distribution } from '../interfaces/Distribution';

const account = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const dao = '0x5DA07af8913A4EAf09E5F569c20138b658906c17';
const before = generateMerkleTree({ [account]: { [token]: '100' }, [dao]: { [token]: '7' } });
// Recover 40; absorb 3 missing tokens from new DAO credit only.
const recovered = generateMerkleTree({ [account]: { [token]: '60' }, [dao]: { [token]: '44' } });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-baseline-'));
try {
    assert.deepEqual(resolveRecoveryBaseline(before, before.merkleRoot, directory), before);
    assert.throws(() => resolveRecoveryBaseline(before, recovered.merkleRoot, directory), /adopt the confirmed recovery/);
    const file = path.join(directory, `${recovered.merkleRoot}.json`);
    fs.writeFileSync(file, JSON.stringify({ sourceRoot: before.merkleRoot, merkle: recovered }));
    const baseline = resolveRecoveryBaseline(before, recovered.merkleRoot, directory);
    const newRewards: Distribution = { timestamp: 200, blockNumber: 20, incentives: [{
        vault: account, token: { address: token, decimals: 18, symbol: 'TOK' },
        distribution: { incentiveId: 1, amountToDistribute: 13n, incentivePerSecond: 1n },
        users: [{ user: account, balance: '1', share: '1', amount: '13' }],
    }] };
    const next = createCombineDistribution(newRewards, baseline);
    assert.equal(next[account][token], '73'); // Old-baseline bug would restore 113.
    assert.equal(next[dao][token], '44');
    assert.equal(BigInt(next[account][token]) + BigInt(next[dao][token]), 117n);
    assert.deepEqual(resolveRecoveryBaseline(recovered, recovered.merkleRoot, directory), recovered);
    fs.writeFileSync(file, JSON.stringify({ sourceRoot: recovered.merkleRoot, merkle: recovered }));
    assert.throws(() => resolveRecoveryBaseline(before, recovered.merkleRoot, directory), /parent mismatch/);
    fs.writeFileSync(file, JSON.stringify({ sourceRoot: before.merkleRoot, merkle: { ...before, merkleRoot: recovered.merkleRoot } }));
    assert.throws(() => resolveRecoveryBaseline(before, recovered.merkleRoot, directory), /root mismatch/);
    console.log('PASS: adopted recovery persists into the next distribution; missing, wrong-parent and tampered baselines reject');
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
