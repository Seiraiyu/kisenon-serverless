// Minimal zero-dependency EventEmitter for the pg-shaped surface (Client, Pool,
// PoolClient). Deliberately NOT Node's `events` module: this package must load
// unmodified in Cloudflare Workers / Vercel Edge / Deno / Bun, none of which
// guarantee `node:events`. Only the handful of pg events we surface are needed:
// 'error' | 'notice' | 'notification' | 'end' | 'connect' | 'remove'.

export type Listener = (...args: unknown[]) => void;

export class EventEmitter {
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, fn: Listener): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return this;
  }

  once(event: string, fn: Listener): this {
    const wrapper: Listener = (...args) => {
      this.off(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string, fn: Listener): this {
    this.listeners.get(event)?.delete(fn);
    return this;
  }

  removeListener(event: string, fn: Listener): this {
    return this.off(event, fn);
  }

  emit(event: string, ...args: unknown[]): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return false;
    // Snapshot so a listener that mutates the set mid-emit is safe.
    for (const fn of [...set]) fn(...args);
    return true;
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
    return this;
  }
}
