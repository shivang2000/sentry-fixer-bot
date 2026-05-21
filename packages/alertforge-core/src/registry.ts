import type { ChannelAdapter, SourceAdapter } from "./types";

class Registry {
  readonly sources: Map<string, SourceAdapter> = new Map();
  readonly channels: Map<string, ChannelAdapter> = new Map();

  registerSource(adapter: SourceAdapter): void {
    if (this.sources.has(adapter.type)) {
      throw new Error(`Source adapter already registered: ${adapter.type}`);
    }
    this.sources.set(adapter.type, adapter);
  }

  registerChannel(adapter: ChannelAdapter): void {
    if (this.channels.has(adapter.type)) {
      throw new Error(`Channel adapter already registered: ${adapter.type}`);
    }
    this.channels.set(adapter.type, adapter);
  }

  /** Used by tests to start from a clean slate. Never call from production code. */
  clear(): void {
    this.sources.clear();
    this.channels.clear();
  }
}

/**
 * Singleton registry. Adapters self-register at boot — typically by
 * importing the adapter module from apps/server/src/index.ts (P2+),
 * which side-effect-calls registry.registerSource(adapter).
 *
 * Discovery is boot-time only; no hot reload (see ADR-0004).
 */
export const registry = new Registry();
