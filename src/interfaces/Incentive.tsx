export interface Incentive {
    id: number;
    gauge: string;         // address of the gauge contract
    reward: string;        // address of the ERC20 reward token
    duration: bigint;      // duration of the incentive in seconds
    start: bigint;         // timestamp when the incentive starts
    end: bigint;           // timestamp when the incentive ends
    fromChainId: bigint;   // chain ID where the incentive was originally created
    sender: string;        // original sender address
}