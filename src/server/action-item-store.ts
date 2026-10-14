import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  ActionItem,
  ActionItemEntity,
  ActionItemEvent,
  ActionItemPriority,
  ActionItemSource,
  ActionItemStatus,
  Entity,
  EntityKind,
  EntityRole,
} from '../shared/types.js';

const ORGANIZATION_SUFFIXES = new Set([
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'llc',
  'ltd',
  'limited',
  'plc',
  'gmbh',
  'ag',
  'sa',
  'bv',
  'pty',
  'lp',
  'llp',
]);

/** Matching key for a name: case, accents, punctuation, and company suffixes do not count. */
export function entityKey(kind: EntityKind, name: string) {
  const words =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  if (kind === 'organization') {
    if (words.length > 1 && words[0] === 'the') words.shift();
    while (words.length > 1 && ORGANIZATION_SUFFIXES.has(words.at(-1)!))
      words.pop();
  }
  return words.join(' ');
}

function editDistance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length];
}

/** Two keys that may name the same thing but are not an exact match. */
export function nearKeys(a: string, b: string) {
  if (!a || !b || a === b) return false;
  const left = new Set(a.split(' '));
  const right = new Set(b.split(' '));
  const [small, large] =
    left.size <= right.size ? [left, right] : [right, left];
  if ([...small].every((word) => large.has(word))) return true;
  const shared = [...left].filter((word) => right.has(word)).length;
  if (shared / (left.size + right.size - shared) >= 0.5) return true;
  // One misspelt word ("Jon Smith"); one-letter words like "Company A" vs "Company Z" differ on purpose.
  const first = a.split(' ');
  const second = b.split(' ');
  if (first.length !== second.length) return false;
  const differing = first
    .map((word, index) => [word, second[index]] as const)
    .filter(([left, right]) => left !== right);
  return (
    differing.length === 1 &&
    Math.min(differing[0][0].length, differing[0][1].length) >= 3 &&
    editDistance(differing[0][0], differing[0][1]) <= 1
  );
}

export interface NewActionItem {
  statement: string;
  details: string;
  context: string;
  status: ActionItemStatus;
  priority: ActionItemPriority;
  dueAt: number | null;
  remindAt: number | null;
  labels: string[];
  createdBy: string;
  source: ActionItemSource;
  links: { entityId: string; role: EntityRole }[];
}

export type ActionItemPatch = Partial<
  Pick<
    ActionItem,
    | 'statement'
    | 'details'
    | 'context'
    | 'status'
    | 'priority'
    | 'dueAt'
    | 'remindAt'
    | 'labels'
  >
>;

/** Whose an item is: the owner's own, owed to the owner, or between other people. */
export type ItemOwnership = 'me' | 'owed' | 'others';

export interface ActionItemFilter {
  statuses?: ActionItemStatus[];
  ownership?: ItemOwnership;
  assigneeIds?: string[];
  requesterIds?: string[];
  /** Every one of these entities must be linked, in any role. */
  entityIds?: string[];
  labels?: string[];
  dueBefore?: number;
  dueAfter?: number;
  ids?: string[];
  limit?: number;
}

type Row = Record<string, SQLInputValue>;

const PRIORITY_RANK =
  "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";
const OPEN = "status IN ('open','waiting')";
const hasRole = (role: EntityRole) =>
  `EXISTS (SELECT 1 FROM action_item_entities l WHERE l.itemId=a.id AND l.role='${role}')`;
/** The owner never appears as an entity, so no requester on someone else's item means the owner asked. */
const OWNERSHIP: Record<ItemOwnership, string> = {
  me: `NOT ${hasRole('assignee')}`,
  owed: `${hasRole('assignee')} AND NOT ${hasRole('requester')}`,
  others: `${hasRole('assignee')} AND ${hasRole('requester')}`,
};

/** Action items, their entities, and their history. The source of truth; search copies live elsewhere. */
export class ActionItemStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS action_items(id TEXT PRIMARY KEY, statement TEXT NOT NULL, details TEXT NOT NULL, context TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL, dueAt INTEGER, remindAt INTEGER, labels TEXT NOT NULL, createdBy TEXT NOT NULL, sourceKind TEXT NOT NULL, sourceId TEXT, sourceRef TEXT, sourceTitle TEXT, sourceExcerpt TEXT NOT NULL, sourceDate TEXT, threadId TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, completedAt INTEGER, indexedAt INTEGER);
      CREATE INDEX IF NOT EXISTS action_items_status ON action_items(status, dueAt);
      CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL, createdAt INTEGER NOT NULL, UNIQUE(kind, key));
      CREATE TABLE IF NOT EXISTS entity_aliases(kind TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, entityId TEXT NOT NULL, PRIMARY KEY(kind, key));
      CREATE TABLE IF NOT EXISTS action_item_entities(itemId TEXT NOT NULL, entityId TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(itemId, entityId, role));
      CREATE INDEX IF NOT EXISTS action_item_entities_entity ON action_item_entities(entityId, role);
      CREATE TABLE IF NOT EXISTS action_item_events(id TEXT PRIMARY KEY, itemId TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, actor TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS action_item_events_item ON action_item_events(itemId, createdAt);
      UPDATE OR IGNORE action_item_entities SET role='assignee' WHERE role='owner';
      DELETE FROM action_item_entities WHERE role='owner';`);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  create(input: NewActionItem, now = Date.now()): ActionItem {
    const id = randomUUID();
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO action_items(id, statement, details, context, status, priority, dueAt, remindAt, labels, createdBy, sourceKind, sourceId, sourceRef, sourceTitle, sourceExcerpt, sourceDate, threadId, createdAt, updatedAt, completedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          input.statement,
          input.details,
          input.context,
          input.status,
          input.priority,
          input.dueAt,
          input.remindAt,
          JSON.stringify(input.labels),
          input.createdBy,
          input.source.kind,
          input.source.id,
          input.source.ref,
          input.source.title,
          input.source.excerpt,
          input.source.date,
          input.source.threadId,
          now,
          now,
          ['done', 'dropped'].includes(input.status) ? now : null,
        );
      for (const link of input.links) this.link(id, link.entityId, link.role);
      this.event(id, 'created', input.statement, input.createdBy, now);
    });
    return this.get(id)!;
  }

  get(id: string): ActionItem | undefined {
    return this.items([id])[0];
  }

  /** Items in the order of `ids`; unknown IDs are skipped. */
  items(ids: string[]): ActionItem[] {
    if (!ids.length) return [];
    const rows = new Map<string, Row>();
    const links = new Map<string, ActionItemEntity[]>();
    for (let start = 0; start < ids.length; start += 500) {
      const chunk = ids.slice(start, start + 500);
      const marks = chunk.map(() => '?').join(',');
      for (const row of this.db
        .prepare(`SELECT * FROM action_items WHERE id IN (${marks})`)
        .all(...chunk) as Row[])
        rows.set(String(row.id), row);
      for (const row of this.db
        .prepare(
          `SELECT l.itemId, l.role, e.id, e.kind, e.name FROM action_item_entities l JOIN entities e ON e.id=l.entityId WHERE l.itemId IN (${marks}) ORDER BY e.name`,
        )
        .all(...chunk) as Row[]) {
        const list = links.get(String(row.itemId)) ?? [];
        list.push({
          id: String(row.id),
          kind: row.kind as EntityKind,
          name: String(row.name),
          role: row.role as EntityRole,
        });
        links.set(String(row.itemId), list);
      }
    }
    return ids
      .map((id) => rows.get(id))
      .filter((row): row is Row => !!row)
      .map((row) => ({
        id: String(row.id),
        statement: String(row.statement),
        details: String(row.details),
        context: String(row.context),
        status: row.status as ActionItemStatus,
        priority: row.priority as ActionItemPriority,
        dueAt: row.dueAt == null ? null : Number(row.dueAt),
        remindAt: row.remindAt == null ? null : Number(row.remindAt),
        labels: JSON.parse(String(row.labels)) as string[],
        createdBy: String(row.createdBy),
        source: {
          kind: row.sourceKind as ActionItemSource['kind'],
          id: row.sourceId == null ? null : String(row.sourceId),
          ref: row.sourceRef == null ? null : String(row.sourceRef),
          title: row.sourceTitle == null ? null : String(row.sourceTitle),
          excerpt: String(row.sourceExcerpt),
          date: row.sourceDate == null ? null : String(row.sourceDate),
          threadId: row.threadId == null ? null : String(row.threadId),
        },
        entities: links.get(String(row.id)) ?? [],
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
        completedAt: row.completedAt == null ? null : Number(row.completedAt),
      }));
  }

  update(id: string, patch: ActionItemPatch, now = Date.now()) {
    const current = this.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    const finished = ['done', 'dropped'].includes(next.status);
    this.db
      .prepare(
        'UPDATE action_items SET statement=?, details=?, context=?, status=?, priority=?, dueAt=?, remindAt=?, labels=?, updatedAt=?, completedAt=? WHERE id=?',
      )
      .run(
        next.statement,
        next.details,
        next.context,
        next.status,
        next.priority,
        next.dueAt,
        next.remindAt,
        JSON.stringify(next.labels),
        now,
        finished ? (current.completedAt ?? now) : null,
        id,
      );
    return this.get(id);
  }

  /** Clears a reminder once given; not a change to the item itself. */
  clearReminder(id: string) {
    this.db.prepare('UPDATE action_items SET remindAt=NULL WHERE id=?').run(id);
  }

  /** Marks an item changed so its search copy is rebuilt. */
  touch(id: string, now = Date.now()) {
    this.db
      .prepare('UPDATE action_items SET updatedAt=? WHERE id=?')
      .run(now, id);
  }

  delete(id: string) {
    return this.transaction(() => {
      this.db
        .prepare('DELETE FROM action_item_entities WHERE itemId=?')
        .run(id);
      this.db.prepare('DELETE FROM action_item_events WHERE itemId=?').run(id);
      return (
        this.db.prepare('DELETE FROM action_items WHERE id=?').run(id).changes >
        0
      );
    });
  }

  link(itemId: string, entityId: string, role: EntityRole) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO action_item_entities(itemId, entityId, role) VALUES (?, ?, ?)',
      )
      .run(itemId, entityId, role);
  }

  unlink(itemId: string, entityId: string, role?: EntityRole) {
    if (role)
      this.db
        .prepare(
          'DELETE FROM action_item_entities WHERE itemId=? AND entityId=? AND role=?',
        )
        .run(itemId, entityId, role);
    else
      this.db
        .prepare(
          'DELETE FROM action_item_entities WHERE itemId=? AND entityId=?',
        )
        .run(itemId, entityId);
  }

  event(
    itemId: string,
    kind: ActionItemEvent['kind'],
    text: string,
    actor: string,
    now = Date.now(),
  ) {
    this.db
      .prepare(
        'INSERT INTO action_item_events(id, itemId, kind, text, actor, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), itemId, kind, text, actor, now);
  }

  events(itemId: string): ActionItemEvent[] {
    return (
      this.db
        .prepare(
          'SELECT id, kind, text, actor, createdAt FROM action_item_events WHERE itemId=? ORDER BY createdAt, rowid',
        )
        .all(itemId) as Row[]
    ).map((row) => ({
      id: String(row.id),
      kind: row.kind as ActionItemEvent['kind'],
      text: String(row.text),
      actor: String(row.actor),
      createdAt: Number(row.createdAt),
    }));
  }

  reminderCounts(ids: string[]) {
    const counts = new Map<string, number>();
    if (!ids.length) return counts;
    for (const row of this.db
      .prepare(
        `SELECT itemId, COUNT(*) AS n FROM action_item_events WHERE kind='reminded' AND itemId IN (${ids.map(() => '?').join(',')}) GROUP BY itemId`,
      )
      .all(...ids) as Row[])
      counts.set(String(row.itemId), Number(row.n));
    return counts;
  }

  /** Matching item IDs, soonest due first, then by priority and newest. */
  filter(filter: ActionItemFilter = {}): string[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.statuses?.length) {
      where.push(`a.status IN (${filter.statuses.map(() => '?').join(',')})`);
      params.push(...filter.statuses);
    }
    if (filter.ownership) where.push(OWNERSHIP[filter.ownership]);
    for (const [role, ids] of [
      ['assignee', filter.assigneeIds],
      ['requester', filter.requesterIds],
    ] as const)
      if (ids?.length) {
        where.push(
          `EXISTS (SELECT 1 FROM action_item_entities l WHERE l.itemId=a.id AND l.role='${role}' AND l.entityId IN (${ids.map(() => '?').join(',')}))`,
        );
        params.push(...ids);
      }
    for (const id of filter.entityIds ?? []) {
      where.push(
        'EXISTS (SELECT 1 FROM action_item_entities l WHERE l.itemId=a.id AND l.entityId=?)',
      );
      params.push(id);
    }
    for (const label of filter.labels ?? []) {
      where.push('EXISTS (SELECT 1 FROM json_each(a.labels) WHERE value=?)');
      params.push(label);
    }
    if (filter.dueBefore != null) {
      where.push('a.dueAt IS NOT NULL AND a.dueAt <= ?');
      params.push(filter.dueBefore);
    }
    if (filter.dueAfter != null) {
      where.push('a.dueAt IS NOT NULL AND a.dueAt >= ?');
      params.push(filter.dueAfter);
    }
    if (filter.ids) {
      if (!filter.ids.length) return [];
      where.push(`a.id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }
    params.push(filter.limit ?? 5_000);
    return (
      this.db
        .prepare(
          `SELECT a.id FROM action_items a ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.dueAt IS NULL, a.dueAt, ${PRIORITY_RANK}, a.createdAt DESC LIMIT ?`,
        )
        .all(...params) as Row[]
    ).map((row) => String(row.id));
  }

  /** IDs grouped for a follow-up review, at most `limit` per group. */
  review(now: number, soonMs: number, staleMs: number, limit = 50) {
    const ids = (sql: string, ...params: SQLInputValue[]) =>
      (
        this.db
          .prepare(
            `SELECT a.id FROM action_items a WHERE ${OPEN} AND ${sql} ORDER BY a.dueAt IS NULL, a.dueAt, ${PRIORITY_RANK}, a.createdAt LIMIT ?`,
          )
          .all(...params, limit) as Row[]
      ).map((row) => String(row.id));
    return {
      overdue: ids(`a.dueAt < ? AND ${OWNERSHIP.me}`, now),
      dueSoon: ids(
        `a.dueAt >= ? AND a.dueAt <= ? AND ${OWNERSHIP.me}`,
        now,
        now + soonMs,
      ),
      reminders: ids('a.remindAt IS NOT NULL AND a.remindAt <= ?', now),
      owedToYouOverdue: ids(`a.dueAt < ? AND ${OWNERSHIP.owed}`, now),
      stale: ids(
        `a.updatedAt < ? AND (a.dueAt IS NULL OR a.dueAt >= ?) AND ${OWNERSHIP.me}`,
        now - staleMs,
        now,
      ),
    };
  }

  /** Items whose search copy is missing or older than the item. */
  stale(limit: number) {
    return (
      this.db
        .prepare(
          'SELECT id, updatedAt FROM action_items WHERE indexedAt IS NULL OR indexedAt < updatedAt ORDER BY updatedAt LIMIT ?',
        )
        .all(limit) as Row[]
    ).map((row) => ({ id: String(row.id), updatedAt: Number(row.updatedAt) }));
  }

  markIndexed(id: string, updatedAt: number) {
    this.db
      .prepare('UPDATE action_items SET indexedAt=? WHERE id=? AND updatedAt=?')
      .run(updatedAt, id, updatedAt);
  }

  /** Recent notes, newest first, for the search copy. */
  notes(itemId: string, limit: number) {
    return (
      this.db
        .prepare(
          "SELECT text FROM action_item_events WHERE itemId=? AND kind='note' ORDER BY createdAt DESC, rowid DESC LIMIT ?",
        )
        .all(itemId, limit) as Row[]
    ).map((row) => String(row.text));
  }

  // Entities

  entity(id: string): Entity | undefined {
    const row = this.db
      .prepare('SELECT id, kind, name FROM entities WHERE id=?')
      .get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      kind: row.kind as EntityKind,
      name: String(row.name),
      aliases: (
        this.db
          .prepare(
            'SELECT name FROM entity_aliases WHERE entityId=? ORDER BY name',
          )
          .all(id) as Row[]
      ).map((alias) => String(alias.name)),
    };
  }

  /** The entity whose name or alias has the same key, of the kind if given. */
  findEntity(name: string, kind?: EntityKind): Entity | undefined {
    for (const candidate of kind
      ? [kind]
      : (['organization', 'person', 'project', 'topic'] as EntityKind[])) {
      const key = entityKey(candidate, name);
      if (!key) continue;
      const row = this.db
        .prepare(
          'SELECT id FROM entities WHERE kind=? AND key=? UNION SELECT entityId AS id FROM entity_aliases WHERE kind=? AND key=?',
        )
        .get(candidate, key, candidate, key) as Row | undefined;
      if (row) return this.entity(String(row.id));
    }
    return undefined;
  }

  /** Entities of the kind whose name or an alias nearly matches, excluding exact matches. */
  nearEntities(name: string, kind: EntityKind, limit = 5): Entity[] {
    const key = entityKey(kind, name);
    const rows = this.db
      .prepare(
        'SELECT id, key FROM entities WHERE kind=? UNION ALL SELECT entityId AS id, key FROM entity_aliases WHERE kind=?',
      )
      .all(kind, kind) as Row[];
    const ids = [
      ...new Set(
        rows
          .filter((row) => nearKeys(key, String(row.key)))
          .map((row) => String(row.id)),
      ),
    ];
    return ids
      .slice(0, limit)
      .map((id) => this.entity(id))
      .filter((entity): entity is Entity => !!entity);
  }

  createEntity(kind: EntityKind, name: string, now = Date.now()): Entity {
    const key = entityKey(kind, name);
    if (!key)
      throw new Error('An entity needs a name with letters or numbers.');
    const existing = this.findEntity(name, kind);
    if (existing) return existing;
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO entities(id, kind, name, key, createdAt) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, kind, name.trim(), key, now);
    return this.entity(id)!;
  }

  entities(query?: string, kind?: EntityKind, limit = 100): Entity[] {
    const params: SQLInputValue[] = [];
    let where = '1=1';
    if (kind) {
      where += ' AND e.kind=?';
      params.push(kind);
    }
    if (query?.trim()) {
      where +=
        " AND (e.name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM entity_aliases s WHERE s.entityId=e.id AND s.name LIKE ? ESCAPE '\\'))";
      const like = `%${query.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      params.push(like, like);
    }
    params.push(limit);
    return (
      this.db
        .prepare(
          `SELECT e.id FROM entities e WHERE ${where} ORDER BY e.name LIMIT ?`,
        )
        .all(...params) as Row[]
    )
      .map((row) => this.entity(String(row.id)))
      .filter((entity): entity is Entity => !!entity);
  }

  /** Items linked to an entity. */
  itemsFor(entityId: string) {
    return (
      this.db
        .prepare(
          'SELECT DISTINCT itemId FROM action_item_entities WHERE entityId=?',
        )
        .all(entityId) as Row[]
    ).map((row) => String(row.itemId));
  }

  /** Takes these entities off every item. Returns the affected items. */
  unlinkEverywhere(entityIds: string[], now = Date.now()) {
    if (!entityIds.length) return [];
    const marks = entityIds.map(() => '?').join(',');
    return this.transaction(() => {
      const items = (
        this.db
          .prepare(
            `SELECT DISTINCT itemId FROM action_item_entities WHERE entityId IN (${marks})`,
          )
          .all(...entityIds) as Row[]
      ).map((row) => String(row.itemId));
      this.db
        .prepare(
          `DELETE FROM action_item_entities WHERE entityId IN (${marks})`,
        )
        .run(...entityIds);
      for (const item of items) this.touch(item, now);
      return items;
    });
  }

  /** Folds `fromId` into `intoId`: links, aliases, and its name move over. Returns the affected items. */
  mergeEntities(fromId: string, intoId: string, now = Date.now()) {
    const from = this.entity(fromId);
    const into = this.entity(intoId);
    if (!from || !into) throw new Error('Entity not found.');
    if (from.id === into.id) throw new Error('Choose two different entities.');
    if (from.kind !== into.kind)
      throw new Error('Only entities of the same kind can be merged.');
    return this.transaction(() => {
      const items = this.itemsFor(from.id);
      this.db
        .prepare(
          'INSERT OR IGNORE INTO action_item_entities(itemId, entityId, role) SELECT itemId, ?, role FROM action_item_entities WHERE entityId=?',
        )
        .run(into.id, from.id);
      this.db
        .prepare('DELETE FROM action_item_entities WHERE entityId=?')
        .run(from.id);
      this.db
        .prepare('UPDATE entity_aliases SET entityId=? WHERE entityId=?')
        .run(into.id, from.id);
      const key = entityKey(from.kind, from.name);
      this.db.prepare('DELETE FROM entities WHERE id=?').run(from.id);
      if (key !== entityKey(into.kind, into.name))
        this.db
          .prepare(
            'INSERT OR REPLACE INTO entity_aliases(kind, key, name, entityId) VALUES (?, ?, ?, ?)',
          )
          .run(from.kind, key, from.name, into.id);
      for (const item of items) this.touch(item, now);
      return items;
    });
  }
}
