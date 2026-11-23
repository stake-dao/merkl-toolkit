import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAddress, PublicClient, zeroAddress } from 'viem';
import repair from '../../config/campaign-supersession.json';
import type { Distribution } from '../interfaces/Distribution';
import type { GaugeHolders } from '../interfaces/GaugeHolders';
import { campaignReserves } from '../utils/monthlyExpiry';

// Reproduce the manifest from immutable repository evidence, including the
// gauge snapshots (the slim reserve replay needs only the distribution blobs).
function archive(timestamp: number, file: string) {
    return execFileSync('git', ['show', `${repair.archiveCommit}:data/distributions/${timestamp}/${file}`]);
}

function campaignWindow(dist: Distribution, id: number) {
    const rows = dist.incentives.filter(row => row.distribution.incentiveId === id);
    assert.equal(rows.length, 1);
    const row = rows[0];
    const gauge: GaugeHolders = JSON.parse(archive(dist.timestamp, `gauges/${row.vault}.json`).toString());
    const windows = gauge.windows.filter(window => window.incentiveId === id);
    assert.equal(gauge.vault, row.vault);
    assert.equal(windows.length, 1);
    const { startTimestamp: start, endTimestamp: end } = windows[0];
    assert(start < end);
    assert.equal(BigInt(end - start) * BigInt(row.distribution.incentivePerSecond), BigInt(row.distribution.amountToDistribute));
    return { start, end, vault: row.vault, token: row.token.address, rate: row.distribution.incentivePerSecond };
}

async function main(directory: string) {
    function copyDistribution(timestamp: number): Distribution {
        const bytes = archive(timestamp, 'distribution.json');
        const folder = path.join(directory, String(timestamp));
        fs.mkdirSync(folder);
        fs.writeFileSync(path.join(folder, 'distribution.json'), bytes);
        return JSON.parse(bytes.toString());
    }
    const replacement = copyDistribution(repair.replacement.timestamp);
    assert.equal(replacement.blockNumber, repair.replacement.blockNumber);
    const windows = new Map(replacement.incentives.map(({ distribution: { incentiveId: id } }) => [id, campaignWindow(replacement, id)]));
    let count = 0;
    for (const source of repair.sources) {
        const dist = copyDistribution(source.timestamp);
        assert.equal(new Set(source.campaigns).size, source.campaigns.length);
        for (const id of source.campaigns) {
            const before = campaignWindow(dist, id), after = windows.get(id)!;
            assert.equal(before.vault, after.vault);
            assert.equal(before.token, after.token);
            assert.equal(before.rate, after.rate);
            assert(after.start <= before.start && before.end <= after.end, `${source.timestamp}/${id} not covered`);
            count++;
        }
    }
    assert.equal(repair.sources.length, 10);
    assert.equal(windows.size, 17);
    assert.equal(count, 116);

    // Fully fund the replacement once, with seven more units promised on #115.
    const campaigns = Array.from({ length: 140 }, () => ({ token: zeroAddress as string, amount: 0n }));
    for (const row of replacement.incentives) campaigns[row.distribution.incentiveId] = { token: row.token.address, amount: BigInt(row.distribution.amountToDistribute) };
    campaigns[115].amount += 7n;
    const client = { readContract: async () => 140n, multicall: async () => campaigns.map(c => [zeroAddress, c.token, 0n, 0n, 0n, 0n, zeroAddress, c.amount]) } as unknown as PublicClient;
    const reserves = () => campaignReserves(client, BigInt(replacement.blockNumber + 1), directory);
    const token = getAddress(campaigns[115].token);
    assert.equal((await reserves()).reserves[token], '7');
    // Another run for the same campaign counts even without an index entry.
    const later = replacement.timestamp + 12;
    fs.mkdirSync(path.join(directory, String(later)));
    const row = replacement.incentives.find(row => row.distribution.incentiveId === 115)!;
    fs.writeFileSync(path.join(directory, String(later), 'distribution.json'), JSON.stringify({ timestamp: later, blockNumber: replacement.blockNumber + 1,
        incentives: [{ ...row, users: [{ ...row.users[0], amount: '5' }], distribution: { ...row.distribution, amountToDistribute: '5' } }] }));
    assert.equal((await reserves()).reserves[token], '2');
    campaigns[115].amount -= 3n;
    await assert.rejects(reserves(), /campaign 115 allocations exceed funding by 1/);
    campaigns[115].amount += 3n;

    for (const entry of [repair.sources[0], repair.replacement]) {
        const file = path.join(directory, String(entry.timestamp), 'distribution.json');
        const original = fs.readFileSync(file);
        fs.appendFileSync(file, '\n');
        await assert.rejects(reserves(), /supersession archive changed/);
        fs.writeFileSync(file, original);
    }
    fs.rmSync(path.join(directory, String(replacement.timestamp)), { recursive: true });
    await assert.rejects(reserves(), /missing campaign supersession archives: 1771914645/);
    console.log('PASS: all 116 reviewed windows on 17 campaigns match their replacement; other allocations, unindexed generations, and negative or incomplete evidence are not ignored');
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-supersession-'));
main(directory).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
