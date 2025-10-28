export function generateBlockSnapshots(
    startBlock: number,
    endBlock: number,
    options?: { numSnapshots?: number; interval?: number }
): number[] {
    if (startBlock >= endBlock) {
        throw new Error('startBlock doit être inférieur à endBlock');
    }

    const snapshots: number[] = [];

    snapshots.push(startBlock);

    if (options?.interval) {
        for (let block = startBlock + options.interval; block < endBlock; block += options.interval) {
            snapshots.push(block);
        }
    } else {
        const numSnapshots = options?.numSnapshots || 10;
        const step = Math.floor((endBlock - startBlock) / (numSnapshots - 1));

        for (let i = 1; i < numSnapshots - 1; i++) {
            snapshots.push(startBlock + step * i);
        }
    }

    if (snapshots[snapshots.length - 1] !== endBlock) {
        snapshots.push(endBlock);
    }

    return snapshots;
}