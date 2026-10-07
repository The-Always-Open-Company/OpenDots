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
export interface State {
  settings: Settings;
  tasks: Task[];
  memories: Memory[];
  mode: 'sample' | 'live';
  configured: boolean;
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
  spaceIds: string[];
  dotIds: string[];
  createdAt: number;
  updatedAt: number;
}
export type DocumentAccessReason = 'all' | 'granted' | 'space';
export interface DocumentReader {
  dotId: string;
  reasons: DocumentAccessReason[];
  /** Linked Spaces that grant this Dot access. */
  viaSpaceIds: string[];
}
export interface DocumentDetail extends DocumentSummary {
  readers: DocumentReader[];
}
export interface WorkspaceState {
  spaces: Space[];
  dots: Dot[];
  conversations: Conversation[];
  setup: SetupStatus;
  calls: CallReceipt[];
}
