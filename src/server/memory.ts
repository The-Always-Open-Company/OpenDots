import type { Memory as Mem0 } from 'mem0ai/oss';
import { EMBEDDING_DIMENSIONS, type Postgres } from './postgres.js';
import { modelJson, withTimeout } from './model-json.js';
import {
  PREFERENCE_MEMORY_INSTRUCTIONS,
  memoriesToStore,
  parsePreferenceMemories,
  preferenceExtractionUser,
  preferenceKey,
} from './preference-memory.js';

export interface LearnedMemory {
  id: string;
  text: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Always set by the server from the session and the running Dot. */
export interface MemoryScope {
  userId: string;
  dotId: string;
}

export interface MemoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface MemoryProvider {
  search(
    scope: MemoryScope,
    query: string,
    limit: number,
  ): Promise<LearnedMemory[]>;
  list(scope: MemoryScope): Promise<LearnedMemory[]>;
  /** Extracts facts from a turn (`infer`) or stores the text as given. */
  add(
    scope: MemoryScope,
    turns: MemoryTurn[],
    options: { infer: boolean; threadId: string },
  ): Promise<void>;
  /** Returns the memory only when it belongs to the scope. */
  get(scope: MemoryScope, id: string): Promise<LearnedMemory | null>;
  update(scope: MemoryScope, id: string, text: string): Promise<boolean>;
  delete(scope: MemoryScope, id: string): Promise<boolean>;
}

export const MAX_LEARNED_MEMORIES = 200;

interface Mem0Item {
  id: string;
  memory: string;
  createdAt?: string;
  updatedAt?: string;
  user_id?: string;
  agent_id?: string;
}

const learned = (item: Mem0Item): LearnedMemory => ({
  id: item.id,
  text: item.memory,
  createdAt: item.createdAt ?? null,
  updatedAt: item.updatedAt ?? null,
});

export class Mem0Provider implements MemoryProvider {
  private instance?: Promise<Mem0>;
  constructor(
    private postgres: Postgres,
    private config: {
      apiKey: string;
      baseUrl: string;
      model: string;
      embeddingModel: string;
    },
  ) {}
  private memory(): Promise<Mem0> {
    this.instance ??= (async () => {
      // Our schema step creates the vector extension before mem0 connects.
      await this.postgres.ensureSchema();
      const { Memory } = await import('mem0ai/oss');
      return new Memory({
        llm: {
          provider: 'openai',
          config: {
            apiKey: this.config.apiKey,
            baseURL: this.config.baseUrl,
            model: this.config.model,
          },
        },
        embedder: {
          provider: 'openai',
          config: {
            apiKey: this.config.apiKey,
            baseURL: this.config.baseUrl,
            model: this.config.embeddingModel,
            embeddingDims: EMBEDDING_DIMENSIONS,
          },
        },
        vectorStore: {
          provider: 'pgvector',
          config: {
            connectionString: this.postgres.url,
            collectionName: 'memories',
            embeddingModelDims: EMBEDDING_DIMENSIONS,
            hnsw: true,
          },
        },
        // Otherwise mem0 writes a SQLite history file into the working directory.
        disableHistory: true,
        customInstructions: PREFERENCE_MEMORY_INSTRUCTIONS,
      });
    })().catch((error: unknown) => {
      this.instance = undefined;
      throw error;
    });
    return this.instance;
  }
  private filters(scope: MemoryScope) {
    return { user_id: scope.userId, agent_id: scope.dotId };
  }
  async search(scope: MemoryScope, query: string, limit: number) {
    if (!query.trim()) return [];
    const memory = await this.memory();
    const result = await memory.search(query.slice(0, 2000), {
      topK: limit,
      filters: this.filters(scope),
    });
    return (result.results as Mem0Item[]).map(learned);
  }
  async list(scope: MemoryScope) {
    const memory = await this.memory();
    const result = await memory.getAll({
      topK: MAX_LEARNED_MEMORIES,
      filters: this.filters(scope),
    });
    return (result.results as Mem0Item[]).map(learned);
  }
  async add(
    scope: MemoryScope,
    turns: MemoryTurn[],
    options: { infer: boolean; threadId: string },
  ) {
    const stored = await memoriesToStore(turns, options.infer, (input) =>
      this.extractPreferences(input),
    );
    if (!stored.length) return;
    const existing = await this.list(scope);
    const known = new Set(existing.map((item) => preferenceKey(item.text)));
    const fresh = stored.filter(
      (turn) => !known.has(preferenceKey(turn.content)),
    );
    if (!fresh.length) return;
    const memory = await this.memory();
    // infer stays off: mem0's own extractor keeps questions, tasks, and replies.
    await memory.add(fresh, {
      userId: scope.userId,
      agentId: scope.dotId,
      infer: false,
      metadata: { source_thread_id: options.threadId },
    });
  }
  private async extractPreferences(turns: MemoryTurn[]) {
    try {
      const value = await withTimeout(
        modelJson(this.config)({
          system: PREFERENCE_MEMORY_INSTRUCTIONS,
          user: preferenceExtractionUser(turns),
          maxTokens: 400,
        }),
        20_000,
      );
      return parsePreferenceMemories(value);
    } catch {
      console.error('Preference extraction failed; nothing saved.');
      return [];
    }
  }
  async get(scope: MemoryScope, id: string) {
    const memory = await this.memory();
    const item = (await memory.get(id).catch(() => null)) as Mem0Item | null;
    return item &&
      item.user_id === scope.userId &&
      item.agent_id === scope.dotId
      ? learned(item)
      : null;
  }
  async update(scope: MemoryScope, id: string, text: string) {
    if (!(await this.get(scope, id))) return false;
    await (await this.memory()).update(id, { text });
    return true;
  }
  async delete(scope: MemoryScope, id: string) {
    if (!(await this.get(scope, id))) return false;
    await (await this.memory()).delete(id);
    return true;
  }
}
