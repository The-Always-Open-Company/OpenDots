import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import { ENTITY_KINDS, type ActionItem, type Entity } from '../shared/types.js';
import {
  actionItemInput,
  actionItemPatch,
  REVIEW_BUCKETS,
  searchInput,
  sourceInput,
  type ActionItemService,
  type Actor,
  type PossibleEntityMatch,
} from './action-items.js';
import { zonedParts } from './schedule-time.js';

const pad = (value: number) => String(value).padStart(2, '0');

/** Local date-time for the model, e.g. "2026-10-16 23:59 America/Chicago". */
export function localTime(ms: number | null, timeZone: string) {
  if (ms == null) return null;
  const parts = zonedParts(ms, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)} ${timeZone}`;
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Compact item for a tool result. */
export function itemView(
  item: ActionItem & { remindersGiven?: number },
  timeZone: string,
) {
  const assignees = item.entities.filter(
    (entity) => entity.role === 'assignee',
  );
  return {
    id: item.id,
    statement: item.statement,
    context: item.context,
    ...(item.details ? { details: clip(item.details, 800) } : {}),
    status: item.status,
    priority: item.priority,
    assignee: assignees.length
      ? assignees.map((entity) => entity.name).join(', ')
      : 'you',
    due: localTime(item.dueAt, timeZone),
    remindAt: localTime(item.remindAt, timeZone),
    labels: item.labels,
    entities: item.entities,
    source: {
      kind: item.source.kind,
      title: item.source.title,
      date: item.source.date,
      ...(item.source.ref ? { ref: item.source.ref } : {}),
      excerpt: clip(item.source.excerpt, 300),
    },
    ...(item.remindersGiven ? { remindersGiven: item.remindersGiven } : {}),
  };
}

/** One row of a list: enough to answer or pick an item to read in full. */
export function summaryView(
  item: ActionItem & { remindersGiven?: number },
  timeZone: string,
) {
  const names = (assignee: boolean) =>
    item.entities
      .filter((entity) => (entity.role === 'assignee') === assignee)
      .map((entity) => entity.name);
  const assignees = names(true);
  const concerns = names(false);
  return {
    id: item.id,
    statement: item.statement,
    status: item.status,
    priority: item.priority,
    assignee: assignees.length ? assignees.join(', ') : 'you',
    due: localTime(item.dueAt, timeZone),
    ...(concerns.length ? { concerns } : {}),
    ...(item.labels.length ? { labels: item.labels } : {}),
    ...(item.remindersGiven ? { remindersGiven: item.remindersGiven } : {}),
  };
}

const MAX_SEARCHES = 5;
const MAX_SEARCH_RESULTS = 50;
const MAX_CALL_RESULTS = 100;

const searchLimit = z
  .number()
  .int()
  .min(1)
  .max(MAX_SEARCH_RESULTS)
  .optional()
  .describe('Default 10.');

/** An ISO date or date-time; the service also takes epoch numbers, the model need not. */
const isoBound = z.string().trim().max(40).optional();

/** One search as the model sees it: date bounds as ISO strings only. */
const toolSearch = searchInput.extend({
  limit: searchLimit,
  dueBefore: isoBound,
  dueAfter: isoBound,
  createdAfter: isoBound,
  createdBefore: isoBound,
  updatedAfter: isoBound,
  updatedBefore: isoBound,
  completedAfter: isoBound,
  completedBefore: isoBound,
});

/**
 * Splits a call's result budget across its searches. Each keeps what it asked
 * for while the total fits; past that, limits shrink in proportion, each
 * keeping at least one slot.
 */
export function shareLimits(requested: number[], budget: number): number[] {
  const total = requested.reduce((sum, value) => sum + value, 0);
  if (total <= budget) return [...requested];
  const shares = requested.map((value) =>
    Math.max(1, Math.floor((value * budget) / total)),
  );
  let over = shares.reduce((sum, value) => sum + value, 0) - budget;
  while (over > 0) {
    const largest = shares.indexOf(Math.max(...shares));
    if (shares[largest]! <= 1) break;
    shares[largest]! -= 1;
    over -= 1;
  }
  return shares;
}

const detail = z
  .enum(['summary', 'full'])
  .optional()
  .describe(
    'summary (default) lists key fields; full adds context, details, entities and source. Prefer read_action_item for one item.',
  );

const entityView = (entity: Entity) => ({
  id: entity.id,
  name: entity.name,
  kind: entity.kind,
  ...(entity.aliases.length ? { aliases: entity.aliases } : {}),
});

const matchView = (match: PossibleEntityMatch) => ({
  name: match.name,
  kind: match.kind,
  newEntityId: match.createdEntityId,
  existing: match.candidates.map(entityView),
});

export function actionItemTools(
  service: ActionItemService,
  deps: {
    dotId: string;
    threadId: string;
    timeZone: string;
    /** A scheduled or background run: reviews mark reminders as given. */
    inWork: boolean;
    check: () => void;
    signal: AbortSignal;
  },
) {
  const actor: Actor = {
    id: deps.dotId,
    dotId: deps.dotId,
    threadId: deps.threadId,
    timeZone: deps.timeZone,
  };
  const view = (item: ActionItem & { remindersGiven?: number }) =>
    itemView(item, deps.timeZone);
  const listView =
    (level: 'summary' | 'full' = 'summary') =>
    (item: ActionItem & { remindersGiven?: number }) =>
      level === 'full' ? view(item) : summaryView(item, deps.timeZone);
  return [
    defineTool({
      name: 'create_action_items',
      description:
        'File things the owner has to do, or that someone owes the owner, in one batch per source. Each item needs a statement that stands alone, the situation it came from, its entities with roles, and the quoted source. Items similar to an open one come back as possible_duplicate instead of being created.',
      parameters: z.object({
        items: z
          .array(actionItemInput.extend({ source: sourceInput }))
          .min(1)
          .max(20),
      }),
      execute: async ({ items }) => {
        deps.check();
        const { results, warnings } = await service.create(
          items,
          actor,
          deps.signal,
        );
        deps.check();
        return {
          results: results.map((result) =>
            result.status === 'created'
              ? {
                  status: result.status,
                  id: result.item.id,
                  statement: result.item.statement,
                  due: localTime(result.item.dueAt, deps.timeZone),
                  ...(result.possibleEntityMatches.length
                    ? {
                        possibleEntityMatches:
                          result.possibleEntityMatches.map(matchView),
                      }
                    : {}),
                }
              : {
                  status: result.status,
                  statement: result.statement,
                  matches: result.matches.map((match) => ({
                    id: match.item.id,
                    statement: match.item.statement,
                    status: match.item.status,
                    similarity: match.similarity,
                  })),
                },
          ),
          ...(warnings.length ? { warnings } : {}),
        };
      },
    }),
    defineTool({
      name: 'search_action_items',
      description:
        "Find the owner's action items. Each entry in `searches` is one independent search by meaning and keywords within filters: entities, who must do them, who asked, status, labels, due dates, and when they were filed (created*), changed (updated*) or finished (completed*). Period bounds are ISO dates or date-times in the owner's time zone; a date alone covers the whole day. Open and waiting items are searched unless statuses or a period bound are given. Up to five searches per call, each returning at most 50 items and the call at most 100; each result says how many were requested and returned and gives nextOffset for its next page.",
      parameters: z.object({
        searches: z
          .array(toolSearch)
          .min(1)
          .max(MAX_SEARCHES)
          .describe('One entry per search; a single search is a list of one.'),
        detail,
      }),
      execute: async ({ detail: level, searches }) => {
        deps.check();
        const requested = searches.map((search) => search.limit ?? 10);
        const allotted = shareLimits(requested, MAX_CALL_RESULTS);
        const results = await Promise.all(
          searches.map(async (search, index) => {
            const found = await service.search(
              { ...search, limit: allotted[index] },
              actor,
              deps.signal,
            );
            return {
              ...found,
              requested: requested[index]!,
              returned: found.items.length,
              cut: allotted[index]! < requested[index]!,
              items: found.items.map(listView(level)),
            };
          }),
        );
        deps.check();
        return { results };
      },
    }),
    defineTool({
      name: 'read_action_item',
      description:
        'Read one action item with its full details, source and history of notes, changes and reminders.',
      parameters: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        deps.check();
        const item = service.detail(id);
        if (!item) throw new Error('Action item not found.');
        return {
          ...view(item),
          details: item.details,
          source: item.source,
          history: item.events.slice(-30).map((event) => ({
            kind: event.kind,
            text: event.text,
            by: event.actor,
            at: localTime(event.createdAt, deps.timeZone),
          })),
        };
      },
    }),
    defineTool({
      name: 'update_action_item',
      description:
        'Change an action item: status (done, dropped, waiting, open), wording, context, priority, due date, reminder, labels, or the entities it concerns. Send null to clear a date.',
      parameters: actionItemPatch.extend({ id: z.string() }),
      execute: async ({ id, ...patch }) => {
        deps.check();
        const { item, possibleEntityMatches } = await service.update(
          id,
          patch,
          actor,
          deps.signal,
        );
        return {
          item: view(item),
          ...(possibleEntityMatches.length
            ? { possibleEntityMatches: possibleEntityMatches.map(matchView) }
            : {}),
        };
      },
    }),
    defineTool({
      name: 'add_action_item_note',
      description:
        'Add a note to an action item: progress, a new deadline mentioned elsewhere, or the same item coming up again in another source.',
      parameters: z.object({
        id: z.string(),
        note: z.string().trim().min(1).max(4000),
      }),
      execute: async ({ id, note }) => {
        deps.check();
        return view(await service.addNote(id, note, actor, deps.signal));
      },
    }),
    defineTool({
      name: 'review_action_items',
      description:
        "What needs following up: the owner's overdue and soon-due items, reminders that have come due, items others owe the owner that are overdue, and items untouched for two weeks. Every bucket reports its total; chosen buckets list a page of summaries, and nextOffset pages further. remindersGiven counts earlier reminders.",
      parameters: z.object({
        buckets: z
          .array(z.enum(REVIEW_BUCKETS))
          .max(REVIEW_BUCKETS.length)
          .optional()
          .describe('Buckets to list items for (default all).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Items per bucket (default 5).'),
        offset: z
          .number()
          .int()
          .min(0)
          .max(500)
          .optional()
          .describe('Items to skip in each bucket, for the next page.'),
        detail,
      }),
      execute: async ({ buckets, limit, offset, detail: level }) => {
        deps.check();
        const review = service.reviewPage(actor, {
          buckets,
          limit: limit ?? 5,
          offset,
          markReminded: deps.inWork,
        });
        return Object.fromEntries(
          Object.entries(review).map(([bucket, page]) => [
            bucket,
            page.items
              ? { ...page, items: page.items.map(listView(level)) }
              : page,
          ]),
        );
      },
    }),
    defineTool({
      name: 'list_entities',
      description:
        'List the organizations, people, projects and topics action items are tagged with, optionally filtered by name or kind.',
      parameters: z.object({
        query: z.string().trim().max(120).optional(),
        kind: z.enum(ENTITY_KINDS).optional(),
      }),
      execute: async ({ query, kind }) => {
        deps.check();
        return service.store.entities(query, kind).map(entityView);
      },
    }),
    defineTool({
      name: 'merge_entities',
      description:
        'Merge two entities that name the same organization, person, project or topic. Use it when they are clearly the same (for example a nickname or a short form of the same name in the same context) or the owner has said so.',
      parameters: z.object({
        fromEntityId: z.string().describe('The entity that goes away.'),
        intoEntityId: z.string().describe('The entity that stays.'),
      }),
      execute: async ({ fromEntityId, intoEntityId }) => {
        deps.check();
        const merged = await service.mergeEntities(
          fromEntityId,
          intoEntityId,
          deps.signal,
        );
        return { entity: entityView(merged.entity), items: merged.items };
      },
    }),
  ];
}

/** Standing rule: when a Pod may touch action items at all. The how lives in the skill. */
export const ACTION_ITEM_BOUNDARY =
  'Use action items when the owner asks for task tracking or an established workflow requires it. Load the action-items skill with load_skill before creating or changing action items. Do not create action items merely because a conversation or document mentions work.';
