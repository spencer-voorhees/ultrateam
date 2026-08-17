// Best-effort USD pricing per 1M tokens, matched by model-name prefix. Token
// counts from the logs are exact; cost is an estimate and is intentionally easy
// to update here (or override) as vendor prices change. Unknown models report
// tokens with no cost rather than a wrong number.

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

// Keyed by a lowercased model-name prefix; longest match wins.
const TABLE: Record<string, ModelPrice> = {
  // Anthropic / Claude Code
  'claude-fable-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-opus-4': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  // OpenAI / Codex
  'gpt-5.6': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 },
  'o4-mini': { input: 1.1, output: 4.4, cacheRead: 0.275 },
  // Google / Gemini
  'gemini-3': { input: 1.25, output: 10, cacheRead: 0.31 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.31 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.075 },
};

export function priceFor(model: string | undefined): ModelPrice | null {
  if (!model) return null;
  const m = model.toLowerCase();
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(TABLE)) {
    if (m.startsWith(key) && (!best || key.length > best.key.length)) best = { key, price };
  }
  return best ? best.price : null;
}

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Estimated USD cost for a token breakdown, or null if the model has no price. */
export function estimateCost(model: string | undefined, t: TokenBreakdown): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const per = (tokens: number, rate: number | undefined) => (rate ? (tokens / 1_000_000) * rate : 0);
  return (
    per(t.input, p.input) +
    per(t.output, p.output) +
    per(t.cacheWrite, p.cacheWrite ?? p.input) +
    per(t.cacheRead, p.cacheRead ?? p.input)
  );
}
