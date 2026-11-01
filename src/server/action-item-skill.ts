import type { SkillDoc } from './skills.js';

export const ACTION_ITEM_SKILL_NAME = 'action-items';

/**
 * Built-in skill listed whenever action items are configured, with no per-Pod
 * grant. A skill folder with the same name does not replace it.
 */
export const ACTION_ITEM_SKILL: SkillDoc = {
  name: ACTION_ITEM_SKILL_NAME,
  description:
    "How to file, find, update and review the owner's action items. Load before creating or changing action items.",
  scripts: [],
  body: [
    '# Action items',
    '',
    "You keep the owner's to-do list. File items only when the owner asks for task tracking or a workflow you are running requires it, not merely because a conversation or document mentions work.",
    '',
    '## Filing',
    '- Use create_action_items with one batch per source.',
    '- Write each statement so it makes sense on its own months later.',
    '- Put the situation in context: which company, topic, meeting or document, and why it matters.',
    '- Tag organizations, people, projects and topics with a role: assignee is someone else who must do it; requester is who asked, when it was not the owner; about is everything else.',
    '- Never tag the owner as an entity under any of their names. Leave out the assignee when the owner must do it, and the requester when the owner asked.',
    '- Quote the source line. Set a due date only when one is stated or clearly implied.',
    '- Then tell the owner briefly what you filed, what matched existing items, and what you were unsure about.',
    '',
    '## Duplicates and entities',
    '- When a result is possible_duplicate, add what is new to the existing item with add_action_item_note. Refile with force only if it is really a different item.',
    '- When a result lists possibleEntityMatches, merge them with merge_entities when they are clearly the same. Ask the owner only when you are unsure.',
    '',
    '## Finding items',
    '- Use search_action_items before answering what the owner has to do or is owed.',
    '- Put independent searches in one call with `searches` (up to five) instead of calling the tool several times.',
    "- For a summary of a period, use the period filters instead of paging a broad search: createdAfter/createdBefore for items filed, completedAfter/completedBefore for items finished, updatedAfter/updatedBefore for items changed. Dates are in the owner's time zone; a date alone covers the whole day.",
    '- Results are short summaries. Call read_action_item for an item whose context, details or source you need.',
    '- Pass nextOffset as offset only when you truly need more than the results shown. A summary rarely needs every item; say how many there are instead.',
    '',
    '## Keeping items current',
    '- Use update_action_item without asking whenever the owner or new content shows an item is done, dropped, waiting or changed.',
    '- If the owner wants reminders or follow-ups, propose a schedule whose objective is to call review_action_items and report what is overdue, due soon, due for a reminder, or owed to the owner.',
  ].join('\n'),
};
