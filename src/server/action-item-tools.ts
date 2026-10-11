import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import { ENTITY_KINDS, type ActionItem, type Entity } from '../shared/types.js';
import {
  actionItemInput,
  actionItemPatch,
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
  const owners = item.entities.filter((entity) => entity.role === 'owner');
  return {
    id: item.id,
    statement: item.statement,
    context: item.context,
    ...(item.details ? { details: clip(item.details, 800) } : {}),
    status: item.status,
    priority: item.priority,
    owner: owners.length
      ? owners.map((entity) => entity.name).join(', ')
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
        "Find the owner's action items by meaning and keywords within filters: entities they concern, who owes them, who asked, status, labels and due dates. Open and waiting items are searched unless statuses are given.",
      parameters: searchInput.extend({
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async (input) => {
        deps.check();
        const found = await service.search(input, actor, deps.signal);
        deps.check();
        return { ...found, items: found.items.map(view) };
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
        "What needs following up: the owner's overdue and soon-due items, reminders that have come due, items others owe the owner that are overdue, and items untouched for two weeks. remindersGiven counts earlier reminders.",
      parameters: z.object({}),
      execute: async () => {
        deps.check();
        const review = service.review(actor, { markReminded: deps.inWork });
        return Object.fromEntries(
          Object.entries(review).map(([bucket, items]) => [
            bucket,
            items.map(view),
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

export const ACTION_ITEM_PROMPT = [
  "Action items: you keep the owner's to-do list. Whenever content the owner shares or discusses (documents, notes, emails, pages, chats) contains something the owner has to do, or something someone owes the owner, file it with create_action_items without being asked, one batch per source.",
  'For each item: write the statement so it makes sense on its own months later; put the situation in context (which company, topic, meeting or document, and why it matters); tag organizations, people, projects and topics with a role (owner is someone else who must do it; requester is who asked; about is everything else). When the person you work for must do it, give it no owner and never tag them as an entity, even when the notes use their name; quote the source line; set a due date only when one is stated or clearly implied.',
  'Then tell the owner briefly what you filed, what matched existing items, and what you were unsure about.',
  'When a result is possible_duplicate, add what is new to the existing item with add_action_item_note; refile with force only if it is really a different item.',
  'When a result lists possibleEntityMatches, merge them with merge_entities when they are clearly the same, and ask the owner only when you are unsure.',
  'Use search_action_items before answering what the owner has to do or is owed, and update_action_item without asking whenever the owner or new content shows something is done, dropped, waiting or changed.',
  'If the owner wants reminders or follow-ups, propose a schedule whose objective is to call review_action_items and report what is overdue, due soon, due for a reminder, or owed to the owner.',
].join(' ');
