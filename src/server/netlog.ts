import crypto from 'crypto';
import type { NetlogCategory, NetlogEntry, NetlogLevel } from '../shared/types.ts';

const MAX_NETLOG_ENTRIES = 300;

export interface NetlogOpts {
  latencyMs?: number;
  throughputMbps?: number;
  meta?: Record<string, string | number | boolean>;
  [key: string]: string | number | boolean | Record<string, string | number | boolean> | undefined;
}

class NetlogService {
  private entries: NetlogEntry[] = [];

  public log(
    category: NetlogCategory,
    level: NetlogLevel,
    message: string,
    opts?: NetlogOpts
  ): NetlogEntry {
    const extraMeta: Record<string, string | number | boolean> = { ...(opts?.meta || {}) };
    if (opts) {
      for (const [k, v] of Object.entries(opts)) {
        if (k === 'latencyMs' || k === 'throughputMbps' || k === 'meta') continue;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          extraMeta[k] = v;
        }
      }
    }

    const entry: NetlogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      category,
      level,
      message,
      latencyMs: opts?.latencyMs,
      throughputMbps: opts?.throughputMbps,
      meta: Object.keys(extraMeta).length > 0 ? extraMeta : undefined,
    };

    this.entries.unshift(entry);
    if (this.entries.length > MAX_NETLOG_ENTRIES) {
      this.entries.length = MAX_NETLOG_ENTRIES;
    }
    return entry;
  }

  public info(category: NetlogCategory, message: string, opts?: NetlogOpts) {
    return this.log(category, 'info', message, opts);
  }

  public warn(category: NetlogCategory, message: string, opts?: NetlogOpts) {
    return this.log(category, 'warn', message, opts);
  }

  public error(category: NetlogCategory, message: string, opts?: NetlogOpts) {
    return this.log(category, 'error', message, opts);
  }

  public getEntries(category?: NetlogCategory, limit = 150): NetlogEntry[] {
    const filtered = category ? this.entries.filter((e) => e.category === category) : this.entries;
    return filtered.slice(0, Math.min(limit, MAX_NETLOG_ENTRIES));
  }

  public clear(): void {
    this.entries = [];
    this.info('system', 'Registro /netlog limpiado manualmente por el operador.');
  }

  public formatForTelegram(limit = 15): string {
    const recent = this.entries.slice(0, limit);
    if (recent.length === 0) {
      return 'Sin eventos registrados en /netlog.';
    }
    return recent
      .map((e) => {
        const time = e.timestamp.slice(11, 19);
        const speed = e.throughputMbps ? ` (${e.throughputMbps.toFixed(1)} MB/s)` : '';
        const lat = e.latencyMs !== undefined ? ` [${e.latencyMs}ms]` : '';
        return `[${time}] [${e.level.toUpperCase()}] [${e.category}] ${e.message}${speed}${lat}`;
      })
      .join('\n');
  }
}

export const netlog = new NetlogService();
