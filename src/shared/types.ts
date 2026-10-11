export type Status =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';
export interface Settings {
  name: string;
  paused: boolean;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  /** Names the owner goes by in notes and documents, e.g. ["Andre Smart", "Andre"]. */
  ownerNames: string[];
}
export interface Task {
  id: string;
  prompt: string;
  status: Status;
  intervalSeconds: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  lease: string | null;
  leaseUntil: number | null;
}
export interface Source {
  title: string;
  url: string;
  excerpt: string;
}
export interface Result {
  text: string;
  sources: Source[];
  sample: boolean;
  screenshot?: string;
}
export interface Run {
  id: string;
  taskId: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  result: Result | null;
  error: string | null;
}
export interface TaskEvent {
  id: number;
  taskId: string;
  runId: string | null;
  text: string;
  createdAt: number;
}
export interface Memory {
  id: string;
  text: string;
  createdAt: number;
}
export interface Detail {
  task: Task;
  runs: Run[];
  events: TaskEvent[];
}
export interface PendingAction {
  id: string;
  toolName: string;
  status: string;
  argumentsJson: string;
  workItemId: string | null;
  threadId?: string;
  createdAt: number;
}
export interface Skill {
  name: string;
  description: string;
  body: string;
  /** Files a skill names but never runs. */
  scripts: string[];
  /** Dots allowed to load this skill. */
  dotIds: string[];
}
export const ACTION_ITEM_STATUSES = [
  'open',
  'waiting',
  'done',
  'dropped',
] as const;
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number];
export const ACTION_ITEM_PRIORITIES = [
  'low',
  'normal',
  'high',
  'urgent',
] as const;
export type ActionItemPriority = (typeof ACTION_ITEM_PRIORITIES)[number];
export const ENTITY_KINDS = [
  'organization',
  'person',
  'project',
  'topic',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
/** assignee: someone else who has to do it (none means the owner of OpenDots); requester: who asked; about: anything else it concerns. */
export const ENTITY_ROLES = ['assignee', 'requester', 'about'] as const;
export type EntityRole = (typeof ENTITY_ROLES)[number];
export interface Entity {
  id: string;
  kind: EntityKind;
  name: string;
  aliases: string[];
}
export interface ActionItemEntity {
  id: string;
  kind: EntityKind;
  name: string;
  role: EntityRole;
}
export interface ActionItemSource {
  kind: 'document' | 'page' | 'conversation' | 'owner';
  /** Document or page ID. */
  id: string | null;
  /** Passage ref (documentId#ordinal) or the page's Space ID. */
  ref: string | null;
  title: string | null;
  /** Saved copy of the quoted text, kept when the source changes. */
  excerpt: string;
  /** When the source happened, e.g. the meeting date, as YYYY-MM-DD. */
  date: string | null;
  threadId: string | null;
}
export interface ActionItem {
  id: string;
  statement: string;
  details: string;
  context: string;
  status: ActionItemStatus;
  priority: ActionItemPriority;
  dueAt: number | null;
  remindAt: number | null;
  labels: string[];
  /** Dot ID, or "owner" for items added through the API. */
  createdBy: string;
  source: ActionItemSource;
  entities: ActionItemEntity[];
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}
export interface ActionItemEvent {
  id: string;
  kind: 'created' | 'note' | 'update' | 'reminded';
  text: string;
  actor: string;
  createdAt: number;
}
export interface WorkView {
  workItem: {
    id: string;
    actorId: string;
    title: string;
    objective: string;
    status: string;
    source: string;
    updatedAt: number;
    workThreadId: string | null;
  };
  executions: {
    id: string;
    status: string;
    attempt: number;
    error: string | null;
  }[];
  events: {
    id: number;
    type: string;
    payloadJson: string;
    createdAt: number;
  }[];
  actions: PendingAction[];
  children: { id: string; title: string; status: string; blocking: number }[];
  triggers: {
    id: string;
    kind: string;
    enabled: number;
    nextRunAt: number | null;
  }[];
  invocations?: {
    id: string;
    executionId: string | null;
    toolName: string;
    status: string;
    resultJson: string | null;
  }[];
  inbound?: { id: string; status: string; payload: string }[];
}
export interface State {
  settings: Settings;
  tasks: Task[];
  memories: Memory[];
  mode: 'sample' | 'live';
  configured: boolean;
  work?: WorkView[];
  actions?: PendingAction[];
  rules?: { id: string; text: string; mode: string; toolNames: string[] }[];
  /** Unread, newest first. */
  notifications?: AppNotification[];
}
export type NotificationKind =
  | 'work_finished'
  | 'work_failed'
  | 'approval_needed'
  | 'reply'
  | 'handoff_failed';
export type HandoffTarget =
  | { kind: 'document'; documentId: string }
  | { kind: 'page'; spaceId: string; pageId: string };
export type HandoffResult =
  | { status: 'started'; workItemId: string }
  | { status: 'waiting'; handoffId: string };
export interface AppNotification {
  id: string;
  kind: NotificationKind;
  dotId: string | null;
  title: string;
  body: string;
  threadId: string | null;
  workItemId: string | null;
  createdAt: number;
  readAt: number | null;
}
export type Action = 'run' | 'pause' | 'cancel';
export interface Space {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}
export interface Dot {
  id: string;
  /** Default destination for saved pages, not ownership. */
  spaceId: string;
  spaceIds: string[];
  name: string;
  instructions: string;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  /** Other Dots may ask this Dot questions with ask_dot. */
  consultable: boolean;
  /** Chosen mascot. Null keeps the color derived from the Dot id. */
  mascot: string | null;
  createdAt: number;
}
export interface Conversation {
  id: string;
  dotId: string;
  ownerId: string;
  title: string;
  createdAt: number;
}
export interface CallReceipt {
  anchorMessageId?: string | null;
  id: string;
  threadId: string;
  startedAt: number;
  endedAt: number | null;
  status: 'connecting' | 'active' | 'ended' | 'failed';
  transcript: string;
  error: string | null;
}
export interface SetupStatus {
  model: boolean;
  browser: boolean;
  voice: boolean;
  /** Learned per-Dot memory: needs DATABASE_URL. */
  memory: boolean;
  /** Document library: needs DATABASE_URL and DOCLING_URL. */
  documents: boolean;
  /** Action items: needs DATABASE_URL and OPENAI_API_KEY for embeddings. */
  actionItems: boolean;
  slack: string;
  missing: string[];
}
export type DocumentStatus = 'queued' | 'processing' | 'ready' | 'failed';
export interface DocumentSummary {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  size: number;
  /** Latest uploaded version; `indexedVersion` is the one Dots can search. */
  version: number;
  indexedVersion: number | null;
  status: DocumentStatus;
  error: string | null;
  allDots: boolean;
  sourceThreadId: string | null;
  sourceDotId: string | null;
  pageCount: number | null;
  convertedChars: number | null;
  chunkCount: number | null;
  /** Model-written overview of the indexed version. */
  summary: string | null;
  tags: string[];
  spaceIds: string[];
  dotIds: string[];
  createdAt: number;
  updatedAt: number;
}
export interface DocumentEntity {
  name: string;
  type: string;
}
export type DocumentAccessReason = 'all' | 'granted' | 'space';
export interface DocumentReader {
  dotId: string;
  reasons: DocumentAccessReason[];
  /** Linked Spaces that grant this Dot access. */
  viaSpaceIds: string[];
}
export interface DocumentDetail extends DocumentSummary {
  entities: DocumentEntity[];
  /** Explains a partial enrichment, when some passages kept headings only. */
  enrichmentNote: string | null;
  readers: DocumentReader[];
}
export interface WorkspaceState {
  spaces: Space[];
  dots: Dot[];
  conversations: Conversation[];
  setup: SetupStatus;
  calls: CallReceipt[];
}
