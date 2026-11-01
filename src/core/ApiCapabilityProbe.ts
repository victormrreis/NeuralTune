export interface CapabilityResult {
  name: string;
  available: boolean;
  detail: string;
}
export const CapabilityResult = {};

export interface CapabilityReport {
  checkedAt: string;
  clientVersion: string | null;
  results: CapabilityResult[];
}
export const CapabilityReport = {};

export type CapabilityCheck = [name: string, check: () => Promise<unknown>];
export const CapabilityCheck = {};

function describe(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const { code, status, message } = err as { code?: unknown; status?: unknown; message?: unknown };
    return `falhou: ${String(code ?? status ?? message ?? 'erro')}`.slice(0, 80);
  }
  return `falhou: ${String(err)}`.slice(0, 80);
}

/**
 * Runs read-only calls and records what the installed client really answers. Only shapes are kept
 * (counts and field names), never response bodies, so a report cannot carry personal data or tokens.
 */
export async function probeCapabilities(checks: readonly CapabilityCheck[], clientVersion: string | null, now: Date = new Date()): Promise<CapabilityReport> {
  const results: CapabilityResult[] = [];

  for (const [name, check] of checks) {
    try {
      const value = await check();
      results.push({ name, available: value !== undefined && value !== null && value !== false, detail: summarizeShape(value) });
    } catch (err) {
      results.push({ name, available: false, detail: describe(err) });
    }
  }

  return { checkedAt: now.toISOString(), clientVersion, results };
}

function summarizeShape(value: unknown): string {
  if (Array.isArray(value)) return `lista(${value.length})`;
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).slice(0, 8).map(([key, item]) => (typeof item === 'number' || typeof item === 'boolean' ? `${key}=${item}` : key)).join(', ');
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value === undefined || value === null ? 'vazio' : 'ok';
}
