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
