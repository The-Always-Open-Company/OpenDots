import { decide } from './authorize.js';
import type { ExecutionEngine } from './execution-engine.js';
import type { PluginService } from './plugins.js';
import { pollFingerprint } from './plugins.js';
import type { Store } from './store.js';
import { watchDecision } from './watches.js';
import type { WorkspaceStore } from './workspace.js';
import { snapshotFor } from './work-tools.js';

type Claim = {
  id: string;
  workItemId: string;
  lease: string;
  actorId?: string;
};

export class WorkRunner {
  private active = new Map<
    string,
    { controller: AbortController; lease: string; workItemId: string }
  >();
  private applying = false;
  private polling = false;
  constructor(
    private engine: ExecutionEngine,
    private store: Store,
    private workspace: WorkspaceStore,
    private plugins: PluginService,
    private run: (claim: Claim, signal: AbortSignal) => Promise<void>,
    private apply: (action: Record<string, unknown>) => Promise<void>,
  ) {}
  async tick() {
    if (this.store.settings().paused) return;
    this.engine.fireDueTriggers();
    this.engine.enqueueStoredEvents((event) =>
      watchDecision(
        this.engine,
        this.store,
        this.workspace,
        event,
        (dotId, pluginId, toolName) =>
          this.plugins.allowed(dotId, pluginId, toolName),
      ),
    );
    if (!this.polling) {
      this.polling = true;
      void this.poll().finally(() => {
        this.polling = false;
      });
    }
    for (let n = 0; n < 3; n += 1) {
      const claim = this.engine.claimExecution() as Claim | null;
      if (!claim) break;
      void this.start(claim);
    }
    if (!this.applying) {
      const action = this.engine.claimApprovedAction() as
        | Record<string, unknown>
        | null;
      if (action) {
        this.applying = true;
        void this.apply(action).finally(() => {
          this.applying = false;
        });
      }
    }
  }
  abort(id: string) {
    this.active.get(id)?.controller.abort(new Error('Run stopped.'));
  }
  abortWork(workItemId: string) {
    for (const job of this.active.values())
      if (job.workItemId === workItemId)
        job.controller.abort(new Error('Run stopped.'));
  }
  abortAll() {
    for (const job of this.active.values())
      job.controller.abort(new Error('Run stopped because settings changed.'));
  }
  stop() {
    for (const [id, job] of this.active) {
      job.controller.abort(new Error('Server stopped during this run.'));
      this.engine.finishExecution(
        id,
        'interrupted',
        'Server stopped during this run.',
      );
    }
    this.active.clear();
  }
  private async poll() {
    const now = Date.now();
    for (const trigger of this.engine.triggersOf('watch')) {
      const spec = JSON.parse(String(trigger.specJson)) as {
        watchKind?: string;
        pluginId?: string;
        toolName?: string;
        arguments?: Record<string, unknown>;
        intervalMs?: number;
        cursor?: string;
        lastHash?: string;
        failures?: number;
      };
      if (spec.watchKind !== 'poll') continue;
      if (trigger.nextRunAt != null && Number(trigger.nextRunAt) > now) continue;
      const interval = Math.max(60_000, Number(spec.intervalMs) || 300_000);
      const dot = this.workspace.dot(String(trigger.actorId));
      const toolName = `plugin_${spec.pluginId}_${spec.toolName}`;
      if (!dot || !spec.pluginId || !spec.toolName) continue;
      const decision = decide(
        {
          actorId: dot.id,
          ownerId: this.workspace.ownerId,
          workItemId: String(trigger.workItemId),
          executionId: '',
          threadId: '',
          mode: 'background',
          cause: 'trigger',
        },
        toolName,
        spec.arguments ?? {},
        {
          ...snapshotFor(
            {
              store: this.store,
              workspace: this.workspace,
              plugins: this.plugins,
              engine: this.engine,
            },
            dot,
            false,
            String(trigger.workItemId),
          ),
          rules: this.engine.rules(),
        },
      );
      if (decision.effect !== 'allow') {
        this.engine.event('auth_denied', {
          workItemId: String(trigger.workItemId),
          triggerId: String(trigger.id),
          actorId: dot.id,
          payload: { toolName, reason: decision.effect === 'block' ? decision.reason : 'pending', cause: 'trigger' },
        });
        this.engine.updateTrigger(String(trigger.id), { nextRunAt: now + interval });
        continue;
      }
      try {
        const result = await this.plugins.call(
          String(trigger.actorId),
          String(spec.pluginId),
          String(spec.toolName),
          { ...(spec.arguments ?? {}), ...(spec.cursor ? { cursor: spec.cursor } : {}) },
        );
        const record =
          result && typeof result === 'object'
            ? (result as { cursor?: unknown; etag?: unknown })
            : {};
        const cursor =
          typeof record.cursor === 'string'
            ? record.cursor
            : typeof record.etag === 'string'
              ? record.etag
              : spec.cursor;
        const fingerprint = pollFingerprint(result);
        const changed = cursor
          ? cursor !== spec.cursor
          : fingerprint !== spec.lastHash;
        if (changed) {
          const payload = JSON.stringify(result);
          this.engine.acceptWebhook(
            String(trigger.id),
            cursor || fingerprint,
            payload.length > 65_536
              ? JSON.stringify({ truncated: true, fingerprint })
              : payload,
          );
        }
        this.engine.updateTrigger(String(trigger.id), {
          spec: { ...spec, cursor, lastHash: fingerprint, failures: 0 },
          nextRunAt: now + interval,
        });
      } catch {
        const failures = Number(spec.failures ?? 0) + 1;
        const delays = [60_000, 300_000, 900_000];
        if (failures > 3)
          this.engine.updateTrigger(String(trigger.id), {
            enabled: false,
            spec: { ...spec, failures },
          });
        else
          this.engine.updateTrigger(String(trigger.id), {
            spec: { ...spec, failures },
            nextRunAt: now + delays[Math.min(failures, delays.length) - 1],
          });
      }
    }
  }
  private async start(claim: Claim) {
    const controller = new AbortController();
    this.active.set(claim.id, {
      controller,
      lease: claim.lease,
      workItemId: claim.workItemId,
    });
    const item = this.engine.workItem(claim.workItemId);
    const policy = this.engine.policy(String(item?.actorId ?? claim.actorId ?? ''));
    const timeout = setTimeout(
      () => controller.abort(new Error('Execution reached its time limit.')),
      policy.maxExecutionMs,
    );
    const ownership = setInterval(() => {
      const current = this.engine.workItem(claim.workItemId);
      if (
        !this.engine.ownsExecution(claim.id, claim.lease) ||
        current?.status === 'cancelled' ||
        current?.status === 'paused' ||
        this.store.settings().paused
      )
        controller.abort(new Error('Run permission or lease was revoked.'));
    }, 100);
    let outcome: 'completed' | 'failed' | 'interrupted' | 'cancelled' = 'completed';
    let error: string | undefined;
    try {
      await this.run(claim, controller.signal);
      const current = this.engine.workItem(claim.workItemId);
      if (controller.signal.aborted)
        outcome = current?.status === 'cancelled' ? 'cancelled' : 'interrupted';
    } catch (caught) {
      const current = this.engine.workItem(claim.workItemId);
      outcome = controller.signal.aborted
        ? current?.status === 'cancelled'
          ? 'cancelled'
          : 'interrupted'
        : 'failed';
      error = caught instanceof Error ? caught.message : 'Execution failed.';
    } finally {
      clearInterval(ownership);
      clearTimeout(timeout);
      this.active.delete(claim.id);
      this.engine.finishExecution(claim.id, outcome, error);
      this.engine.settleInbound(claim.id, outcome);
    }
  }
}
