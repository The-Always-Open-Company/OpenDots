import { Check, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { ComputerToolRenderProps } from './ComputerToolCard';

const labels: Record<string, string> = {
  search_web: 'Searching the web',
  web_search: 'Searching the web',
  read_public_page: 'Reading a web page',
  web_fetch: 'Reading a web page',
  search_documents: 'Searching your documents',
  list_documents: 'Looking through your documents',
  read_document: 'Reading a document',
  read_passage: 'Reading a passage',
  list_authorized_spaces: 'Checking Spaces',
  list_space_pages: 'Looking through pages',
  read_space_page: 'Reading a page',
  create_space_page: 'Creating a page',
  edit_space_page: 'Editing a page',
  search_memories: 'Recalling preferences',
  remember: 'Remembering a preference',
  list_notes: 'Reading notes',
  update_note: 'Updating a note',
  forget: 'Forgetting a note',
  ask_dot: 'Asking another Dot',
  load_skill: 'Loading a skill',
  list_work: 'Checking objectives',
  read_work: 'Reading an objective',
  start_objective: 'Starting an objective',
  start_delegation: 'Delegating work',
  wait_for: 'Waiting on work',
  continue_work: 'Continuing an objective',
  stop_work: 'Stopping an objective',
  complete_work: 'Completing an objective',
  fail_work: 'Closing an objective',
  propose_schedule: 'Proposing a schedule',
  update_schedule: 'Updating a schedule',
  cancel_schedule: 'Cancelling a schedule',
  propose_profile: 'Proposing a profile change',
  list_responsibilities: 'Checking responsibilities',
  upsert_responsibility: 'Saving a responsibility',
  close_responsibility: 'Closing a responsibility',
};

export function toolActivityLabel(name: string) {
  if (labels[name]) return labels[name];
  const words = name
    .replace(/^plugin_/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Using a tool';
}

function failed(result: unknown) {
  let value = result;
  if (typeof value === 'string')
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  return (
    !!value &&
    typeof value === 'object' &&
    ('error' in value || (value as { status?: unknown }).status === 'error')
  );
}

export function ToolActivity({
  name,
  status,
  result,
}: ComputerToolRenderProps) {
  const complete = status === 'complete';
  const error = complete && failed(result);
  return (
    <div className={`tool-activity ${error ? 'error' : ''}`} role="status">
      {!complete ? (
        <LoaderCircle size={13} className="spin" />
      ) : error ? (
        <TriangleAlert size={13} />
      ) : (
        <Check size={13} />
      )}
      <span>{toolActivityLabel(name)}</span>
    </div>
  );
}
