import { Fragment, type ReactNode } from 'react';
import type { AssistantMessage, Message } from '@ag-ui/core';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import { pageReviewTool } from '../shared/page-review';
import { toolActivityLabel } from './ToolActivity';

type ToolCall = NonNullable<AssistantMessage['toolCalls']>[number];

/** Computer screens and page review stay visible. Everything else is a one-line step. */
export function isCardTool(name: string) {
  return name.startsWith('computer_') || name === pageReviewTool.name;
}

export type TraceStep =
  | { kind: 'thought'; id: string; text: string }
  | { kind: 'tools'; message: AssistantMessage; calls: ToolCall[] };

export type TranscriptItem =
  | { kind: 'message'; message: Message; anchorIds: string[] }
  | { kind: 'trace'; id: string; steps: TraceStep[]; anchorIds: string[] }
  | {
      kind: 'cards';
      id: string;
      message: AssistantMessage;
      calls: ToolCall[];
      anchorIds: string[];
    };

function messageText(message: Message) {
  if (message.role === 'activity' || message.role === 'tool') return '';
  return typeof message.content === 'string' ? message.content.trim() : '';
}

function stepId(step: TraceStep) {
  return step.kind === 'thought' ? step.id : step.calls[0].id;
}

/** A one-line description of the tool steps in a trace. */
export function workPhrase(labels: string[]) {
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  const unique: string[] = [];
  for (const label of labels) if (!unique.includes(label)) unique.push(label);
  if (unique.length === 1) return `${unique[0]} · ${labels.length} steps`;
  const [first, second] = unique;
  if (labels.length === 2) return `${first} and ${second}`;
  return `${first}, ${second}, and ${labels.length - 2} more`;
}

export function traceLineCount(steps: TraceStep[]) {
  return steps.reduce(
    (count, step) => count + (step.kind === 'thought' ? 1 : step.calls.length),
    0,
  );
}

/** One tool line stays as it is. A thought, or several steps, fold into one row. */
export function traceCollapses(steps: TraceStep[]) {
  if (traceLineCount(steps) > 1) return true;
  return steps.length === 1 && steps[0].kind === 'thought';
}

export function traceSummary(steps: TraceStep[], live = false) {
  const thoughts = steps.filter((step) => step.kind === 'thought').length;
  const labels = steps.flatMap((step) =>
    step.kind === 'tools'
      ? step.calls.map((call) => toolActivityLabel(call.function.name))
      : [],
  );
  const count = thoughts + labels.length;
  if (live) {
    const latest = labels.at(-1);
    if (latest) return count > 1 ? `${latest} · ${count} steps` : latest;
    return 'Thinking';
  }
  const parts: string[] = [];
  if (thoughts === 1) parts.push('Thought');
  else if (thoughts > 1) parts.push(`${thoughts} thoughts`);
  const work = workPhrase(labels);
  if (work) parts.push(work);
  return parts.join(' · ');
}

/**
 * Pulls consecutive thoughts and one-line tool steps into one trace, placed
 * before the reply they belong to. Computer and review cards stay inline.
 */
export function buildTranscriptItems(messages: Message[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let steps: TraceStep[] = [];
  const anchors: string[] = [];
  const flushTrace = () => {
    if (!steps.length) return;
    items.push({
      kind: 'trace',
      id: stepId(steps[0]),
      steps,
      anchorIds: anchors.splice(0),
    });
    steps = [];
  };
  for (const message of messages) {
    if (message.role === 'reasoning') {
      const text = messageText(message);
      if (text) steps.push({ kind: 'thought', id: message.id, text });
      continue;
    }
    if (message.role !== 'assistant') {
      flushTrace();
      items.push({
        kind: 'message',
        message,
        anchorIds: [message.id, ...anchors.splice(0)],
      });
      continue;
    }
    const text = messageText(message);
    const calls = message.toolCalls ?? [];
    const quiet = calls.filter((call) => !isCardTool(call.function.name));
    const cards = calls.filter((call) => isCardTool(call.function.name));
    if (quiet.length) steps.push({ kind: 'tools', message, calls: quiet });
    if (!text && !cards.length) {
      anchors.push(message.id);
      continue;
    }
    flushTrace();
    const rest = anchors.splice(0);
    if (cards.length) {
      if (text) items.push({ kind: 'message', message, anchorIds: [] });
      items.push({
        kind: 'cards',
        id: cards[0].id,
        message,
        calls: cards,
        anchorIds: [message.id, ...rest],
      });
    } else
      items.push({
        kind: 'message',
        message,
        anchorIds: [message.id, ...rest],
      });
  }
  flushTrace();
  if (anchors.length && items.length)
    items[items.length - 1].anchorIds.push(...anchors);
  return items;
}

export function AgentTrace({
  steps,
  live = false,
  renderTools,
}: {
  steps: TraceStep[];
  live?: boolean;
  renderTools: (message: AssistantMessage) => ReactNode;
}) {
  const tools = (step: Extract<TraceStep, { kind: 'tools' }>) =>
    renderTools({ ...step.message, toolCalls: step.calls });
  if (!traceCollapses(steps)) {
    const step = steps[0];
    return step?.kind === 'tools' ? <>{tools(step)}</> : null;
  }
  return (
    <details className="agent-trace">
      <summary>
        <ChevronRight size={13} className="chevron" aria-hidden />
        {live && <LoaderCircle size={13} className="spin" />}
        <span>{traceSummary(steps, live)}</span>
      </summary>
      <div className="agent-trace-body">
        {steps.map((step) =>
          step.kind === 'thought' ? (
            <p key={step.id} className="agent-thought">
              {step.text}
            </p>
          ) : (
            <Fragment key={step.calls.map((call) => call.id).join(' ')}>
              {tools(step)}
            </Fragment>
          ),
        )}
      </div>
    </details>
  );
}
