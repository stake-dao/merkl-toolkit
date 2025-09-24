export function safeStringify(obj: any): string {
    return JSON.stringify(obj, (_, value) =>
        typeof value === 'bigint' ? value.toString() : value
    );
}

export function safeParse(json: string): any {
    return JSON.parse(json, (_, value) => {
        if (typeof value === 'string' && /^\d+n?$/.test(value)) {
            try {
                return BigInt(value.replace(/n$/, ''));
            } catch {
                return value;
            }
        }
        return value;
    });
}