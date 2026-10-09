import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { approvalDenied } from './approved-actions.js';
import type { ExecutionEngine } from './execution-engine.js';
import type { Platform } from './platform.js';
import type { PluginService } from './plugins.js';
import { initialRunAt, parseSchedule } from './schedule-time.js';
import {
  deleteSkill,
  isSkillName,
  loadSkills,
  readSkillMarkdown,
  saveSkill,
} from './skills.js';
import type { Store } from './store.js';
import type { Runner } from './runner.js';
import { dedupKey, hookSecretHash, secretsMatch } from './watches.js';
import type { WorkRunner } from './work-runner.js';

const scheduleSpec = z.object({
  kind: z.enum(['interval', 'calendar']),
  seconds: z.number().int().min(60).max(31_536_000).optional(),
  timezone: z.string().min(1).max(80).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  minuteOfDay: z.number().int().min(0).max(1439).optional(),
  endAt: z.number().int().optional(),
});

export function capabilityRoutes(
  app: Hono,
  options: {
    engine: ExecutionEngine;
    store: Store;
    runner: Runner;
    work?: WorkRunner;
    platform?: Platform;
    plugins: PluginService;
    skillsDir: string;
  },
) {
  const { engine, store, runner, work, platform, plugins, skillsDir } = options;
  app.post('/api/work', async (c) => {
    const parsed = z
      .object({
        dotId: z.string(),
        title: z.string().trim().min(1).max(160),
        objective: z.string().trim().min(1).max(4000),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Enter a title and an objective.' }, 400);
    if (platform && !platform.workspace.dot(parsed.data.dotId))
      return c.json({ error: 'Dot not found.' }, 404);
    const item = engine.createWorkItem({
      actorId: parsed.data.dotId,
      title: parsed.data.title,
      objective: parsed.data.objective,
      source: 'owner',
      autoResume: false,
    });
    const executionId = engine.enqueueExecution(String(item.id));
    return c.json({ ...item, executionId }, 201);
  });
  app.get('/api/work/:id', (c) => {
    const detail = engine.detail(c.req.param('id'));
    return detail
      ? c.json(detail)
      : c.json({ error: 'Objective not found.' }, 404);
  });
  app.post('/api/work/:id/actions', async (c) => {
    const parsed = z
      .object({ action: z.enum(['pause', 'resume', 'cancel']) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Unknown objective action.' }, 400);
    const id = c.req.param('id');
    const ok =
      parsed.data.action === 'pause'
        ? engine.pauseWork(id)
        : parsed.data.action === 'resume'
          ? engine.resumeWork(id)
          : engine.cancelWork(id);
    if (parsed.data.action !== 'resume') work?.abortWork(id);
    return ok
      ? c.json(engine.workItem(id))
      : c.json({ error: 'Objective not found.' }, 404);
  });
  app.post('/api/actions/:id/approve', (c) => {
    const id = c.req.param('id');
    const proposed = engine.action(id);
    const denied =
      platform && proposed?.status === 'pending'
        ? approvalDenied(
            { engine, workspace: platform.workspace, store, plugins },
            proposed,
          )
        : null;
    const action = engine.approveAction(id, !denied, denied ?? undefined);
    if (!action) return c.json({ error: 'Action not found.' }, 404);
    return c.json({ status: action.status, actionId: action.id });
  });
  app.post('/api/actions/:id/decline', (c) => {
    const action = engine.declineAction(
      c.req.param('id'),
      'Declined by the owner.',
    );
    if (!action) return c.json({ error: 'Action not found.' }, 404);
    return c.json({ status: action.status, actionId: action.id });
  });
  app.post('/api/triggers/:id/disable', (c) => {
    const trigger = engine.updateTrigger(c.req.param('id'), { enabled: false });
    return trigger
      ? c.json(trigger)
      : c.json({ error: 'Trigger not found.' }, 404);
  });
  app.post('/api/engine/cutover', async (c) => {
    engine.prepareCutover();
    const deadline = Date.now() + 180_000;
    while (
      Date.now() < deadline &&
      store.tasks().some((task) => task.status === 'running')
    )
      await new Promise((resolve) => setTimeout(resolve, 200));
    engine.beginCutover(
      (task) => {
        if (task.lease)
          store.interrupt(
            { ...task, lease: task.lease },
            'Cut over to the execution engine.',
          );
        runner.abort(task.id);
      },
      () => store.tasks(),
      (task) =>
        platform?.workspace.legacyTaskOwner(task.id) ?? { actorId: 'legacy' },
    );
    return c.json({ cutover: engine.cutover });
  });
  app.post('/api/rules', async (c) => {
    const parsed = z
      .object({
        text: z.string().trim().min(1).max(500),
        mode: z.enum(['allow', 'ask', 'block']),
        toolNames: z.array(z.string().min(1).max(80)).max(20).default([]),
        dotId: z.string().nullable().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid rule.' }, 400);
    const id = engine.saveRule(parsed.data);
    return c.json({ id, ...parsed.data }, 201);
  });
  app.delete('/api/rules/:id', (c) =>
    engine.deleteRule(c.req.param('id'))
      ? c.json({ ok: true })
      : c.json({ error: 'Rule not found.' }, 404),
  );
  const skillMarkdown = z
    .object({ markdown: z.string().min(1).max(20_000) })
    .strict();
  const skillError = (error: unknown) =>
    error instanceof Error ? error.message : 'Skill could not be saved.';
  app.get('/api/skills', (c) => {
    const grants = engine.skillGrants();
    return c.json(
      loadSkills(skillsDir).map((skill) => ({
        ...skill,
        dotIds: grants.get(skill.name) ?? [],
      })),
    );
  });
  app.get('/api/skills/:name', (c) => {
    const name = c.req.param('name');
    const skill = loadSkills(skillsDir).find((item) => item.name === name);
    const markdown = readSkillMarkdown(skillsDir, name);
    if (!skill || markdown == null)
      return c.json({ error: 'Skill not found.' }, 404);
    return c.json({
      ...skill,
      markdown,
      dotIds: engine.skillGrants().get(name) ?? [],
    });
  });
  app.post('/api/skills', async (c) => {
    const parsed = skillMarkdown.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        { error: 'Add SKILL.md text up to 20,000 characters.' },
        400,
      );
    try {
      return c.json(saveSkill(skillsDir, parsed.data.markdown), 201);
    } catch (error) {
      const message = skillError(error);
      return c.json(
        { error: message },
        message.includes('already exists') ? 409 : 400,
      );
    }
  });
  app.put('/api/skills/:name', async (c) => {
    const parsed = skillMarkdown.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        { error: 'Add SKILL.md text up to 20,000 characters.' },
        400,
      );
    try {
      return c.json(
        saveSkill(skillsDir, parsed.data.markdown, {
          replace: c.req.param('name'),
        }),
      );
    } catch (error) {
      const message = skillError(error);
      return c.json(
        { error: message },
        message === 'Skill not found.' ? 404 : 400,
      );
    }
  });
  app.delete('/api/skills/:name', (c) => {
    const name = c.req.param('name');
    if (!isSkillName(name) || !deleteSkill(skillsDir, name))
      return c.json({ error: 'Skill not found.' }, 404);
    engine.forgetSkill(name);
    return c.json({ deleted: true });
  });
  app.post('/api/dots/:id/skills', async (c) => {
    const parsed = z
      .object({ name: z.string().trim().min(1).max(64) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Name a skill to enable.' }, 400);
    if (platform && !platform.workspace.dot(c.req.param('id')))
      return c.json({ error: 'Dot not found.' }, 404);
    if (!loadSkills(skillsDir).some((skill) => skill.name === parsed.data.name))
      return c.json({ error: 'Skill not found.' }, 404);
    engine.grantSkill(c.req.param('id'), parsed.data.name);
    return c.json({ ok: true });
  });
  app.delete('/api/dots/:id/skills/:name', (c) => {
    engine.revokeSkill(c.req.param('id'), c.req.param('name'));
    return c.json({ ok: true });
  });
  app.put('/api/dots/:id/policy', async (c) => {
    const parsed = z
      .object({
        maxExecutionsPerDay: z.number().int().positive().optional(),
        maxConcurrent: z.number().int().positive().optional(),
        minWakeIntervalMs: z.number().int().positive().optional(),
        maxWakeHorizonMs: z.number().int().positive().optional(),
        maxExecutionMs: z.number().int().positive().optional(),
        maxExecutionsPerWorkItem: z.number().int().positive().optional(),
        defaultWakeIntervalMs: z.number().int().positive().optional(),
        timezone: z.string().min(1).max(80).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid wake policy.' }, 400);
    try {
      return c.json(engine.savePolicy(c.req.param('id'), parsed.data));
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error ? error.message : 'Invalid wake policy.',
        },
        400,
      );
    }
  });
  app.post('/api/plugins', async (c) => {
    const parsed = z
      .object({
        id: z.string(),
        name: z.string().trim().min(1).max(80),
        url: z.string().url(),
        tokenEnv: z.string(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid plugin.' }, 400);
    try {
      return c.json(plugins.save(parsed.data), 201);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Invalid plugin.' },
        400,
      );
    }
  });
  app.post('/api/plugins/:id/refresh', async (c) => {
    try {
      return c.json(await plugins.refresh(c.req.param('id'), false));
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error ? error.message : 'Plugin refresh failed.',
        },
        400,
      );
    }
  });
  app.post('/api/plugins/:id/accept', async (c) => {
    try {
      return c.json(await plugins.refresh(c.req.param('id'), true));
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Plugin schema was not accepted.',
        },
        400,
      );
    }
  });
  app.post('/api/plugins/:id/grants', async (c) => {
    const parsed = z
      .object({
        dotId: z.string(),
        toolName: z.string().min(1),
        mode: z.enum(['allow', 'deny']),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid plugin grant.' }, 400);
    try {
      plugins.grant(
        parsed.data.dotId,
        c.req.param('id'),
        parsed.data.toolName,
        parsed.data.mode,
      );
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error ? error.message : 'Invalid plugin grant.',
        },
        400,
      );
    }
  });
  app.post('/api/watches', async (c) => {
    const parsed = z
      .object({
        dotId: z.string(),
        title: z.string().trim().min(1).max(160),
        objective: z.string().trim().min(1).max(4000),
        watchKind: z.enum(['webhook', 'internal', 'poll']),
        event: z.enum(['page.updated', 'document.ready']).optional(),
        spaceId: z.string().optional(),
        pluginId: z.string().optional(),
        toolName: z.string().optional(),
        arguments: z.record(z.string(), z.unknown()).optional(),
        intervalMs: z.number().int().min(60_000).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (
      !parsed.success ||
      (platform && !platform.workspace.dot(parsed.data.dotId))
    )
      return c.json({ error: 'Invalid watch.' }, 400);
    const data = parsed.data;
    if (data.watchKind === 'internal' && !data.event)
      return c.json({ error: 'Choose a page or document event.' }, 400);
    if (data.watchKind === 'poll' && (!data.pluginId || !data.toolName))
      return c.json({ error: 'Choose a plugin tool to poll.' }, 400);
    const item = engine.createWorkItem({
      actorId: data.dotId,
      title: data.title,
      objective: data.objective,
      source: 'watch',
      autoResume: true,
    });
    const secret =
      data.watchKind === 'webhook'
        ? randomBytes(24).toString('hex')
        : undefined;
    const spec =
      data.watchKind === 'webhook'
        ? { watchKind: 'webhook', secretHash: hookSecretHash(secret!) }
        : data.watchKind === 'internal'
          ? { watchKind: 'internal', event: data.event, spaceId: data.spaceId }
          : {
              watchKind: 'poll',
              pluginId: data.pluginId,
              toolName: data.toolName,
              arguments: data.arguments ?? {},
              intervalMs: data.intervalMs ?? 300_000,
            };
    const id = engine.addTrigger({
      workItemId: String(item.id),
      actorId: data.dotId,
      kind: 'watch',
      spec,
      enabled: true,
      nextRunAt:
        data.watchKind === 'poll'
          ? Date.now() + (data.intervalMs ?? 300_000)
          : null,
    });
    return c.json(
      {
        id,
        workItemId: item.id,
        ...(secret ? { secret, url: `/api/hooks/${id}` } : {}),
      },
      201,
    );
  });
  app.post('/api/hooks/:id', async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > 65_536)
      return c.json({ error: 'Webhook body is too large.' }, 413);
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > 65_536)
      return c.json({ error: 'Webhook body is too large.' }, 413);
    const trigger = engine.trigger(c.req.param('id'));
    if (!trigger || trigger.kind !== 'watch')
      return c.json({ error: 'Watch not found.' }, 404);
    const spec = JSON.parse(String(trigger.specJson)) as {
      secretHash?: string;
    };
    const provided =
      c.req.header('x-opendots-token') ?? c.req.header('x-hook-secret') ?? '';
    if (!spec.secretHash || !secretsMatch(spec.secretHash, provided))
      return c.json({ error: 'Webhook secret is invalid.' }, 401);
    if (engine.countInbound(String(trigger.id), Date.now() - 3_600_000) >= 30)
      return c.json({ error: 'This watch reached its hourly limit.' }, 429);
    const saved = engine.acceptWebhook(
      String(trigger.id),
      dedupKey(c.req.header('idempotency-key'), raw),
      raw,
    );
    return c.json({ ok: true, duplicate: saved.duplicate });
  });
  app.post('/api/inbound/:id/replay', (c) => {
    const saved = engine.replayInbound(c.req.param('id'));
    return saved ? c.json(saved) : c.json({ error: 'Event not found.' }, 404);
  });
  return {
    scheduleSpec,
    parseOwnerSchedule(input: unknown) {
      const spec = parseSchedule(input);
      const nextRunAt = initialRunAt(spec, Date.now());
      if (nextRunAt == null)
        throw new Error('That schedule has no upcoming run.');
      return { spec, nextRunAt };
    },
  };
}
