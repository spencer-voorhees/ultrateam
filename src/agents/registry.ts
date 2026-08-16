// Known coding agents and the providers behind their models. Icons are emoji
// placeholders until the web viewer ships real provider SVGs.

export interface AgentMeta {
  display: string;
  provider: string;
  icon: string;
}

export const AGENTS: Record<string, AgentMeta> = {
  'claude-code': { display: 'Claude Code', provider: 'anthropic', icon: '✴️' },
  cursor: { display: 'Cursor', provider: 'cursor', icon: '⬛' },
  copilot: { display: 'GitHub Copilot', provider: 'github', icon: '🐙' },
  codex: { display: 'Codex', provider: 'openai', icon: '🌀' },
  gemini: { display: 'Gemini', provider: 'google', icon: '♊' },
  'gemini-cli': { display: 'Gemini CLI', provider: 'google', icon: '♊' },
  antigravity: { display: 'Antigravity', provider: 'google', icon: '♊' },
  windsurf: { display: 'Windsurf', provider: 'windsurf', icon: '🏄' },
  opencode: { display: 'OpenCode', provider: 'opencode', icon: '⌨️' },
  zed: { display: 'Zed', provider: 'zed', icon: '⚡' },
  human: { display: 'Human', provider: 'human', icon: '🧑‍💻' },
};

export const UNKNOWN_AGENT: AgentMeta = { display: 'Unknown agent', provider: 'unknown', icon: '🤖' };

export function agentMeta(name: string): AgentMeta {
  return AGENTS[name] ?? { ...UNKNOWN_AGENT, display: name };
}

/**
 * Map an MCP client name (from the initialize handshake) to a canonical agent
 * key. Client names in the wild are inconsistent ("claude", "Claude Code",
 * "cursor-vscode", "Visual Studio Code"), so match loosely.
 */
export function normalizeAgentName(clientName: string | undefined): string | null {
  if (!clientName) return null;
  const n = clientName.toLowerCase();
  if (n.includes('claude')) return 'claude-code';
  if (n.includes('cursor')) return 'cursor';
  if (n.includes('copilot') || n.includes('visual studio') || n.includes('vscode')) return 'copilot';
  if (n.includes('codex')) return 'codex';
  if (n.includes('gemini') || n.includes('antigravity')) return 'gemini';
  if (n.includes('windsurf')) return 'windsurf';
  if (n.includes('opencode')) return 'opencode';
  if (n.includes('zed')) return 'zed';
  return null;
}

const MODEL_PROVIDERS: Array<[RegExp, string]> = [
  [/^claude/i, 'anthropic'],
  [/^(gpt|o\d|chatgpt|codex)/i, 'openai'],
  [/^gemini/i, 'google'],
  [/^grok/i, 'xai'],
  [/^llama/i, 'meta'],
  [/^deepseek/i, 'deepseek'],
  [/^qwen/i, 'alibaba'],
  [/^(mistral|codestral|devstral)/i, 'mistral'],
];

/** Infer the model provider from the model id, falling back to the agent's default provider. */
export function inferProvider(agentName: string, model?: string): string | undefined {
  if (model) {
    for (const [re, provider] of MODEL_PROVIDERS) {
      if (re.test(model)) return provider;
    }
  }
  return AGENTS[agentName]?.provider;
}
