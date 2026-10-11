import { z } from 'zod';
import type {
  PluginAdapter,
  PluginAuth,
  PluginRow,
  RemoteTool,
} from '../plugin-adapters.js';
import { pluginFetch } from '../plugin-network.js';

const API = 'https://www.googleapis.com/calendar/v3';
const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;

const READ_EVENTS = [
  scope('calendar'),
  scope('calendar.readonly'),
  scope('calendar.events'),
  scope('calendar.events.readonly'),
];
const LIST_CALENDARS = [
  scope('calendar'),
  scope('calendar.readonly'),
  scope('calendar.calendarlist'),
  scope('calendar.calendarlist.readonly'),
];
const FREE_BUSY = [
  ...READ_EVENTS,
  scope('calendar.freebusy'),
  scope('calendar.events.freebusy'),
];
const WRITE_EVENTS = [scope('calendar'), scope('calendar.events')];

const calendarId = {
  type: 'string',
  description: 'Calendar id. Defaults to primary.',
};
const eventId = { type: 'string', description: 'Event id.' };
const time = (what: string) => ({
  type: 'string',
  description: `${what} as an RFC 3339 date-time with offset, or YYYY-MM-DD for an all-day event.`,
});
const attendees = {
  type: 'array',
  items: { type: 'string' },
  description: 'Attendee email addresses.',
};

const TOOLS: (RemoteTool & { scopes: string[] })[] = [
  {
    name: 'list_calendars',
    description: 'List the calendars this integration may use.',
    schema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    scopes: LIST_CALENDARS,
  },
  {
    name: 'list_events',
    description:
      'List events in a time range, soonest first. Optionally filter by free text.',
    schema: {
      type: 'object',
      properties: {
        calendarId,
        timeMin: time('Range start'),
        timeMax: time('Range end'),
        query: { type: 'string', description: 'Free-text filter.' },
        maxResults: { type: 'integer', description: 'Up to 50.' },
      },
      required: ['timeMin'],
    },
    annotations: { readOnlyHint: true },
    scopes: READ_EVENTS,
  },
  {
    name: 'get_event',
    description: 'Read one event.',
    schema: {
      type: 'object',
      properties: { calendarId, eventId },
      required: ['eventId'],
    },
    annotations: { readOnlyHint: true },
    scopes: READ_EVENTS,
  },
  {
    name: 'find_free_time',
    description: 'Return busy intervals for calendars in a time range.',
    schema: {
      type: 'object',
      properties: {
        calendarIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Calendar ids. Defaults to primary.',
        },
        timeMin: time('Range start'),
        timeMax: time('Range end'),
        timeZone: { type: 'string', description: 'IANA time zone.' },
      },
      required: ['timeMin', 'timeMax'],
    },
    annotations: { readOnlyHint: true },
    scopes: FREE_BUSY,
  },
  {
    name: 'create_event',
    description: 'Create an event.',
    schema: {
      type: 'object',
      properties: {
        calendarId,
        summary: { type: 'string', description: 'Event title.' },
        description: { type: 'string' },
        location: { type: 'string' },
        start: time('Start'),
        end: time('End'),
        timeZone: { type: 'string', description: 'IANA time zone.' },
        attendees,
      },
      required: ['summary', 'start', 'end'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    scopes: WRITE_EVENTS,
  },
  {
    name: 'update_event',
    description:
      'Change an event. Only the fields you pass change; attendees replaces the whole list.',
    schema: {
      type: 'object',
      properties: {
        calendarId,
        eventId,
        summary: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        start: time('Start'),
        end: time('End'),
        timeZone: { type: 'string', description: 'IANA time zone.' },
        attendees,
      },
      required: ['eventId'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    scopes: WRITE_EVENTS,
  },
  {
    name: 'respond_to_event',
    description: 'Accept, decline or tentatively accept an invitation.',
    schema: {
      type: 'object',
      properties: {
        calendarId,
        eventId,
        response: {
          type: 'string',
          enum: ['accepted', 'declined', 'tentative'],
        },
      },
      required: ['eventId', 'response'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    scopes: WRITE_EVENTS,
  },
  {
    name: 'delete_event',
    description: 'Delete an event.',
    schema: {
      type: 'object',
      properties: { calendarId, eventId },
      required: ['eventId'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    scopes: WRITE_EVENTS,
  },
];

const configSchema = z
  .object({
    calendars: z
      .array(z.string().trim().min(1).max(200))
      .max(50)
      .default(['primary']),
    attendeeDomains: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter domains like example.com.'),
      )
      .max(50)
      .default([]),
    sendUpdates: z.enum(['none', 'externalOnly', 'all']).default('none'),
    allowDelete: z.boolean().default(false),
  })
  .strict();

export type CalendarConfig = z.infer<typeof configSchema>;

function config(plugin: PluginRow): CalendarConfig {
  return configSchema.parse(JSON.parse(plugin.configJson || '{}'));
}

/** Matches `primary` and the connected account's own calendar id. */
function calendarAllowed(cfg: CalendarConfig, plugin: PluginRow, id: string) {
  const own = plugin.accountLabel?.toLowerCase();
  const normalized = own && id.toLowerCase() === own ? 'primary' : id;
  return cfg.calendars.some(
    (allowed) =>
      allowed === normalized ||
      allowed === id ||
      (own && allowed.toLowerCase() === own && normalized === 'primary'),
  );
}

function attendeeDomains(cfg: CalendarConfig, plugin: PluginRow) {
  if (cfg.attendeeDomains.length) return cfg.attendeeDomains;
  const domain = plugin.accountLabel?.split('@')[1]?.toLowerCase();
  return domain ? [domain] : [];
}

function strings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function when(value: string, timeZone?: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? { date: value }
    : { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

interface GoogleEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: unknown;
  end?: unknown;
  status?: string;
  htmlLink?: string;
  organizer?: { email?: string };
  attendees?: { email?: string; responseStatus?: string; self?: boolean }[];
}

function slim(event: GoogleEvent) {
  return {
    id: event.id,
    summary: event.summary,
    description: event.description?.slice(0, 2000),
    location: event.location,
    start: event.start,
    end: event.end,
    status: event.status,
    link: event.htmlLink,
    organizer: event.organizer?.email,
    attendees: event.attendees?.map((a) => ({
      email: a.email,
      response: a.responseStatus,
    })),
  };
}

async function request<T>(
  auth: PluginAuth,
  method: string,
  path: string,
  options: {
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  } = {},
): Promise<T> {
  const url = new URL(API + path);
  for (const [key, value] of Object.entries(options.query ?? {}))
    if (value !== undefined && value !== '')
      url.searchParams.set(key, String(value));
  const response = await pluginFetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  const data = (text ? JSON.parse(text) : {}) as {
    error?: { message?: string };
  };
  if (!response.ok)
    throw new Error(
      `Google Calendar returned ${response.status}: ${data.error?.message ?? response.statusText}`,
    );
  return data as T;
}

const path = (calendar: string, event?: string) =>
  `/calendars/${encodeURIComponent(calendar)}/events${event ? `/${encodeURIComponent(event)}` : ''}`;

export const googleCalendarAdapter: PluginAdapter = {
  kind: 'google-calendar',
  validateConfig(input) {
    const parsed = configSchema.safeParse(input ?? {});
    if (!parsed.success)
      throw new Error(
        parsed.error.issues[0]?.message ?? 'Invalid calendar settings.',
      );
    return parsed.data;
  },
  async listTools(_plugin, auth) {
    return TOOLS.filter((tool) =>
      tool.scopes.some((needed) => auth.scopes.includes(needed)),
    ).map(({ scopes: _scopes, ...tool }) => tool);
  },
  checkArgs(plugin, name, args) {
    const cfg = config(plugin);
    if (name === 'delete_event' && !cfg.allowDelete)
      return 'Deleting events is turned off for this integration.';
    const calendars =
      name === 'list_calendars'
        ? []
        : name === 'find_free_time'
          ? strings(args.calendarIds).length
            ? strings(args.calendarIds)
            : ['primary']
          : [typeof args.calendarId === 'string' ? args.calendarId : 'primary'];
    for (const id of calendars)
      if (!calendarAllowed(cfg, plugin, id))
        return `Calendar ${id} is not allowed for this integration.`;
    if (name === 'create_event' || name === 'update_event') {
      const domains = attendeeDomains(cfg, plugin);
      for (const email of strings(args.attendees)) {
        const domain = email.split('@')[1]?.toLowerCase() ?? '';
        if (!domains.includes(domain))
          return domains.length
            ? `Attendees must use ${domains.join(', ')}.`
            : 'This integration may not invite attendees.';
      }
    }
    return null;
  },
  async accountLabel(_plugin, auth) {
    const own = await request<{ id?: string }>(
      auth,
      'GET',
      '/users/me/calendarList/primary',
    );
    return own.id ?? null;
  },
  async callTool(plugin, auth, name, args) {
    const cfg = config(plugin);
    const calendar =
      typeof args.calendarId === 'string' ? args.calendarId : 'primary';
    const text = (key: string) =>
      typeof args[key] === 'string' ? (args[key] as string) : undefined;
    const timeZone = text('timeZone');
    if (name === 'list_calendars') {
      const listed = await request<{
        items?: {
          id: string;
          summary?: string;
          primary?: boolean;
          accessRole?: string;
          timeZone?: string;
        }[];
      }>(auth, 'GET', '/users/me/calendarList');
      return {
        calendars: (listed.items ?? [])
          .filter((item) =>
            calendarAllowed(cfg, plugin, item.primary ? 'primary' : item.id),
          )
          .map((item) => ({
            id: item.primary ? 'primary' : item.id,
            summary: item.summary,
            accessRole: item.accessRole,
            timeZone: item.timeZone,
          })),
      };
    }
    if (name === 'list_events') {
      const listed = await request<{ items?: GoogleEvent[] }>(
        auth,
        'GET',
        path(calendar),
        {
          query: {
            timeMin: text('timeMin'),
            timeMax: text('timeMax'),
            q: text('query'),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: Math.min(
              50,
              Math.max(1, Number(args.maxResults) || 25),
            ),
          },
        },
      );
      return { events: (listed.items ?? []).map(slim) };
    }
    if (name === 'get_event')
      return slim(
        await request<GoogleEvent>(
          auth,
          'GET',
          path(calendar, text('eventId')),
        ),
      );
    if (name === 'find_free_time') {
      const ids = strings(args.calendarIds).length
        ? strings(args.calendarIds)
        : ['primary'];
      const busy = await request<{
        calendars?: Record<string, { busy?: unknown[] }>;
      }>(auth, 'POST', '/freeBusy', {
        body: {
          timeMin: text('timeMin'),
          timeMax: text('timeMax'),
          ...(timeZone ? { timeZone } : {}),
          items: ids.map((id) => ({ id })),
        },
      });
      return { calendars: busy.calendars ?? {} };
    }
    const fields = () => {
      const body: Record<string, unknown> = {};
      for (const key of ['summary', 'description', 'location'])
        if (text(key) !== undefined) body[key] = text(key);
      if (text('start')) body.start = when(text('start')!, timeZone);
      if (text('end')) body.end = when(text('end')!, timeZone);
      if (Array.isArray(args.attendees))
        body.attendees = strings(args.attendees).map((email) => ({ email }));
      return body;
    };
    const query = { sendUpdates: cfg.sendUpdates };
    if (name === 'create_event')
      return slim(
        await request<GoogleEvent>(auth, 'POST', path(calendar), {
          query,
          body: fields(),
        }),
      );
    if (name === 'update_event')
      return slim(
        await request<GoogleEvent>(
          auth,
          'PATCH',
          path(calendar, text('eventId')),
          { query, body: fields() },
        ),
      );
    if (name === 'respond_to_event') {
      const event = await request<GoogleEvent>(
        auth,
        'GET',
        path(calendar, text('eventId')),
      );
      const list = event.attendees ?? [];
      if (!list.some((a) => a.self))
        throw new Error('The connected account is not invited to this event.');
      return slim(
        await request<GoogleEvent>(
          auth,
          'PATCH',
          path(calendar, text('eventId')),
          {
            query,
            body: {
              attendees: list.map((a) =>
                a.self ? { ...a, responseStatus: text('response') } : a,
              ),
            },
          },
        ),
      );
    }
    if (name === 'delete_event') {
      await request(auth, 'DELETE', path(calendar, text('eventId')), {
        query,
      });
      return { deleted: true, eventId: text('eventId') };
    }
    throw new Error(`Google Calendar has no tool named ${name}.`);
  },
};
