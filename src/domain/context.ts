// Rough token estimate used for pack budgets; providers report exact usage afterwards.

export const estimateTokens = (text: string) => Math.ceil(new TextEncoder().encode(text).length / 4);
