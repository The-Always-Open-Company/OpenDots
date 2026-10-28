# Running the template

Pods runs a React app and a Node server. The server stores pages, Space and Pod configuration, and full conversation history in SQLite, and connects to your configured model and speech services.

## Local development

Use Node.js 24 and npm.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:5173. The API runs on port 4310. Without model credentials, the app shows its setup state; it does not generate simulated replies.

During `npm run dev`, both http://localhost:5173 and http://127.0.0.1:5173 are allowed browser origins. The UI sends API requests through Vite's `/api` proxy. To use a different proxy or custom domain, set `APP_ORIGIN` to one exact origin or a comma-separated list, for example `APP_ORIGIN=http://localhost:5173,http://127.0.0.1:5173`. An explicit value replaces the development defaults. Origins must match the scheme, hostname, and port exactly; omit paths and trailing slashes. Whitespace around list entries is trimmed and empty entries are ignored. Outside development, leaving `APP_ORIGIN` unset requires the browser origin to match the request URL's origin. This setting preserves cross-site request blocking; it does not enable direct cross-origin browser access to the API.

For a built local app:

```sh
npm run build
npm start
```

Open http://127.0.0.1:4310. Keep the server running for background work.

## Conversations

Conversations need only a model. Set `OPENAI_API_KEY` and `OPENAI_MODEL` (and `OPENAI_BASE_URL` for any other OpenAI-compatible chat-completions endpoint), then restart. No CopilotKit account, CLI login, or cloud service is used.

Every conversation's messages and run events are stored in the SQLite database. The browser loads a conversation by reconnecting to it, and scheduled tasks and call receipts run in-process in the same stored conversation, so an open chat window shows them live. The stored history is authoritative: a browser can append new messages and answers to the review tool, but cannot rewrite or inject earlier turns.

### Long conversations

Each model call is kept within an estimated token budget, `CONTEXT_MAX_TOKENS` (default 100000, estimated as characters divided by 4). When a conversation grows past it:

1. The output of older tool calls is replaced with a short stub; the three most recent tool results are kept.
2. If that is not enough, older turns are replaced by a summary, keeping about half the budget of recent turns verbatim. Summaries are cached per conversation and extended incrementally, so each turn summarizes only what is new.
3. If the summary call fails, the older turns are dropped with a marker instead of failing the turn.

Summaries use `SUMMARY_MODEL`, which defaults to `OPENAI_MODEL`. Stored history is never rewritten; compaction affects only what is sent to the model. The system prompt and the tool definitions sent with every call count against the same budget, so history gets what is left (at least 20000, or half the budget when that is smaller).

### Tools sent to the model

Every tool definition is sent with every model call, so a Pod with many plugins or computer tools pays for them on each turn. With `LAZY_TOOLS` on (the default), only common tools are sent in full; the rest (plugin tools, computer tools, schedules, responsibilities, notes and most objective tools) are listed by name, and the model loads the ones it needs for the rest of that reply. Permissions are checked on every call either way. Set `LAZY_TOOLS=off` to send every tool, and `LOG_CONTEXT_SIZE=1` to log the estimated prompt and tool tokens for each reply.

### Turn limit

A reply can take several model turns: each turn may call tools, and the next turn reads their results. `MAX_AGENT_TURNS` caps those turns per reply. It is off by default, so a reply continues until the model answers or the 90-second reply time limit is reached. When a limit is set, the last allowed turn cannot call tools and must answer from what was already found.

### Connection settings

Edit `.env` on the server and restart after changes:

| Variable                         | Purpose                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Model credential and model identifier                                           |
| `OPENAI_BASE_URL`                | Compatible model API endpoint                                                   |
| `OPENAI_API`                     | `chat-completions` (default) or `responses`; see below                          |
| `CONTEXT_MAX_TOKENS`             | Estimated token budget for history sent to the model                            |
| `SUMMARY_MODEL`                  | Model for summaries of older turns; defaults to the model                       |
| `FAST_MODEL`                     | Simple turns, tasks and briefs; default `gpt-6-luna`, `off` uses the main model |
| `DECISIONS_MODEL`                | Decisions router; default `gpt-6-luna`, `off` skips classification              |
| `ROUTER_MIN_CONFIDENCE`          | Lowest `simple` confidence for a chat turn on `FAST_MODEL`, 0–1; default 0.8    |
| `TASK_SPLIT`                     | `on` (default) splits several requests into parallel tasks; `off` keeps one     |
| `MAX_AGENT_TURNS`                | Model turns per reply, 2–100; unset or `off` means no limit                     |
| `LAZY_TOOLS`                     | `on` (default) loads rarely used tools on demand; `off` sends all               |
| `LOG_CONTEXT_SIZE`               | `1` logs estimated prompt and tool tokens per reply                             |
| `OWNER_ID`                       | Stable identity used for this deployment's conversations                        |
| `DATABASE_PATH`                  | SQLite file containing conversations, pages, and metadata                       |
| `OWNER_TOKEN`                    | Application access token; required for external bindings                        |
| `APP_ORIGIN`                     | Comma-separated exact browser origins for a proxy or custom domain              |

`.env.example` and `compose.yml` default to `gpt-6.1-sol` for conversations, `gpt-5.4-mini` for the four background models, and `gpt-6-luna` for `FAST_MODEL` and `DECISIONS_MODEL`. `gpt-6.1-sol` only calls tools through the Responses API, so they also set `OPENAI_API=responses`. Without `OPENAI_API`, conversations use the chat-completions API, which every OpenAI-compatible endpoint serves; set `OPENAI_API=chat-completions` when you point `OPENAI_BASE_URL` and `OPENAI_MODEL` at another provider. That setting applies to conversations only. Summaries, memory extraction, document indexing and search reranking still use chat completions, so point `SUMMARY_MODEL`, `MEMORY_MODEL`, `ENRICHMENT_MODEL` and `RERANK_MODEL` at a model that serves it, typically a small, fast one.

Each chat turn is classified by the [Decisions API](https://developers.openai.com/api/docs/guides/decisions) with `DECISIONS_MODEL` (`gpt-6-luna`; the Decisions API only answers on Luna). Classification usually takes 0.2 to 1.2 seconds and runs alongside memory and document search. A call that has not answered after 400 ms is sent once more and the first answer wins; after 2.5 seconds the turn goes on without it. Turns it rates `simple` with at least `ROUTER_MIN_CONFIDENCE` confidence use `FAST_MODEL`, which also defaults to `gpt-6-luna`. Every other turn, and every turn when the classification fails or times out, uses `OPENAI_MODEL`. Background work and consultations always use `OPENAI_MODEL`. Set `FAST_MODEL=off` to keep every turn on `OPENAI_MODEL`, or `DECISIONS_MODEL=off` to skip classification. `FAST_MODEL` turns go through `OPENAI_API`, so it must serve that API.

The same Decisions call asks whether the message holds several independent requests, such as "check the weather and book a table". Above a 0.7 probability, `FAST_MODEL` splits it into up to four tasks, each with a label, its own brief, a `simple` or `reasoning` rating, and the earlier tasks it needs results from. The turn then answers with the list of tasks, without a model call, and each task runs in a hidden thread of its own, three at a time, for up to 90 seconds. Each result is posted to the chat on its own, with a notification, as soon as it is ready. A message the splitter returns as one task, or a split that fails, runs as a normal turn. Set `TASK_SPLIT=off` to answer every message in one turn.

Tasks, both split chat tasks and call tasks, run on `FAST_MODEL` unless their rating is an explicit `reasoning`; a low-confidence `simple`, a missing rating or a failed classification all use `FAST_MODEL`. A task on `FAST_MODEL` that reports it needs more reasoning runs once more on the reasoning model. Actions that need the owner's approval cannot be approved inside a task: the task prepares them and reports what it would do, and you confirm in the chat.

Logs show where a turn's time goes: `Decisions ok` (with `ms`, OpenAI's `processingMs`, `requestId`, `attempts` and which attempt won), `Turn preparation` (memory, documents, Decisions and split timings), `Document retrieval` (plan, embed, search, rerank and expand timings), and `Model route` for each turn and task, with `source` set to `decisions`, `splitter` or `default`.

Provider credentials belong in `.env`, not client-side variables or source code. CopilotKit and mem0 telemetry are disabled in code; no telemetry setting is needed.

## Memory and documents

Learned memory and the document library need two extra services: Postgres with pgvector, and docling-serve for converting files. Both are optional. Without them, chat and pages work as before; the Memory screen and Documents explorer say what is missing.

| Variable                       | Purpose                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`            | Password for the bundled Postgres service. Generate with `openssl rand -hex 24` |
| `DATABASE_URL`                 | Postgres with pgvector. Enables learned memory, document search, action items   |
| `DOCLING_URL`                  | docling-serve endpoint. With `DATABASE_URL`, enables document uploads           |
| `EMBEDDING_MODEL`              | Embedding model; defaults to `text-embedding-3-small` (1536 dimensions)         |
| `MEMORY_MODEL`                 | Model that extracts memories from turns; defaults to `OPENAI_MODEL`             |
| `ENRICHMENT_MODEL`             | Model that writes summaries, tags and passage context; defaults to the model    |
| `RERANK_MODEL`                 | Model that plans searches and reranks passages; defaults to `OPENAI_MODEL`      |
| `DOCUMENTS_DIR`                | Where original and converted files are kept; defaults next to the database      |
| `MAX_UPLOAD_MB`                | Largest accepted file, 1–2000 MB; default 50                                    |
| `DOCLING_MAX_DOCUMENT_TIMEOUT` | Seconds docling-serve may spend on one file (compose only); default 900         |

Embeddings and memory extraction use `OPENAI_API_KEY` and `OPENAI_BASE_URL`, so a custom endpoint must also serve `/embeddings` with a 1536-dimension model. SQLite remains the source of truth for documents, grants and Space links; Postgres holds only searchable data (memory vectors, document passages and the search copy of action items). Changing who can read a document takes effect immediately without re-indexing.

For `npm run dev`, run the two services on loopback with the development compose file, then set the URLs in `.env`:

```sh
docker compose -f compose.dev.yml up -d
# .env
# DATABASE_URL=postgres://opendots:<POSTGRES_PASSWORD>@127.0.0.1:5433/opendots
# DOCLING_URL=http://127.0.0.1:5001
```

Both compose files build a small layer on the docling-serve image that downloads the tokenizer its chunker needs, so docling-serve never fetches models at runtime. The base image is several gigabytes, so the first build takes a while and needs internet access; later starts do not. Run `docker compose build --pull docling` to pick up a newer docling-serve release.

### Memory

The Memory screen has two parts. **About me** holds preferences you write yourself; every Pod with memory enabled sees them. **Learned by each Pod** lists facts each Pod picked up from its own conversations, which you can edit or delete. After a turn finishes, the Pod's memory model reads what you said and its reply (never tool output, web pages or documents) and stores durable facts for that Pod only. Before each turn, the Pod recalls the learned memories most relevant to your latest message. Pods can also save a fact when you ask them to remember something.

Turn memory off per Pod or for the whole workspace in Settings. Turning it off stops both recall and learning.

### Asking another Pod

A Pod can ask another Pod a question with its `ask_dot` tool. The answer comes from the other Pod's own memories, documents and Spaces. Consultations run in a separate conversation per pair of Pods, are limited to one level (a consulted Pod cannot consult further) and to 45 seconds, and the consulted Pod cannot edit pages, save memories or use its computer. Clear **Other Pods can consult this Pod** in a Pod's settings to opt it out.

### Documents

Open **Documents** in the sidebar to browse, search and upload. When uploading, choose which Pods can read the file: none directly, specific Pods, or all Pods (including ones you add later). Linking a document to a Space also lets every Pod that works in that Space read it. Spaces show their linked documents below the page list, with **Upload** and **Link existing**.

Supported files are PDF, Word, PowerPoint, Excel, HTML, Markdown, text, CSV, PNG and JPEG; the server checks the content matches the extension. Uploads are converted in the background, one at a time. A document becomes searchable once it shows **Ready**. Uploading a new version keeps the previous one searchable until the new one finishes. Uploading identical content again shares the existing document instead of indexing it twice.

Attach files in chat with the paperclip. Attachments are saved to the library, shared with the Pod you are talking to, and linked to the page's Space when the chat is about a page. The message waits until each attachment is ready.

#### How documents are indexed

docling splits each file into passages of about 512 tokens along its headings and tables. The enrichment model then reads the document and writes:

- a short summary, topic tags and the main names it mentions (shown on the document page and used to filter the library);
- for each passage, one or two sentences placing it in the document, plus keywords and names ([contextual retrieval](https://www.anthropic.com/news/contextual-retrieval)). Passages are sent in batches by section, four calls at a time.

Each passage is embedded together with the document title, its section and that context, and indexed for keyword search with headings and keywords weighted highest. Passages are linked to the most similar passages and to passages that name the same things, in any document. If an enrichment call fails, those passages keep their headings only; the document still becomes **Ready** and its page notes the partial enrichment. **Reprocess** retries.

When indexing changes in an update, documents indexed the old way are re-indexed automatically on start. They stay searchable while that runs, and docling is not run again.

#### How Pods search

Before each reply, the search model plans the search from the latest message, the recent conversation and the Pod's catalog of documents. It writes a self-contained question (so "what about the second one?" works), three to five varied queries, a hypothetical answer, and related tags. Every query runs as a keyword and semantic search, the tags match passage keywords and names, and the results are merged with reciprocal rank fusion. The search model then scores the top 40 for relevance. The best six are kept, with at most three per document and two per section, and each comes with its neighbouring passages and references to related passages. Greetings and small talk skip the search. If the search model is slow or fails, plain search of the message is used.

Pods can also call `list_documents`, `search_documents` (the same pipeline for a query of their own, optionally limited to documents or tags), `read_passage` (to open a related passage) and `read_document`. Each call checks the Pod's current access, and related passages from documents the Pod cannot read are never shown.

Searching adds two model calls to each turn that involves documents, usually one to three seconds; a small, fast `RERANK_MODEL` keeps this low. Indexing costs one call for the document and one per eight passages.

Back up `DOCUMENTS_DIR` together with the SQLite database. The Postgres data can be rebuilt by reprocessing documents, but learned memories live only in Postgres, so back up its volume too.

### Action items

Pods keep a list of things to follow up on: what you need to do, and what others owe you. Action items need `DATABASE_URL` and `OPENAI_API_KEY`; without them the tools, API and screen are not available.

Open **Action items** on the icon rail to see them. Its badge counts your items that are overdue or due within three days. The list is grouped into overdue, due soon, upcoming, no due date, waiting, owed to you, and between others (someone else's task for a third person); turn on **Show completed** to include done and dropped items. Type in the search box to rank items by meaning instead, and filter by who owes it, status, person or organization, label and due dates. Clicking a person, organization or label on an item filters by it. Select an item to see its context, the people involved and their roles, the quoted source with a link back to the document, page or conversation, and its history. From there you can mark it done, waiting or dropped, reopen it, change its priority, due date or reminder date, add a note, or delete it. Dates you pick are read in your browser's timezone.

When a Pod reads something with commitments in it (meeting notes, an email thread, a document, or your own message), it files them with `create_action_items` and tells you what it filed. Each item keeps:

- a statement that makes sense on its own, the surrounding context, and optional details;
- status (open, waiting, done, dropped), priority, due date, reminder date and labels;
- the people, organizations, projects and topics involved, each with a role: `assignee` (who must do it), `requester` (who asked for it), or `about`. You are never tagged: no assignee means the item is yours, and an assignee with no requester means it is owed to you;
- where it came from: the document and passage, the page, or the conversation, with a short quote;
- a history of notes, changes and reminders.

Meeting notes usually name you like anyone else ("Andre to send the matrix"). So that those items are filed as yours, open workspace settings and enter the **Names you go by**, separated by commas, for example `Andre Smart, Andre`. Pods are told these names mean you, and the server leaves any person with one of these names (or an alias merged into them) off the items it saves. Saving the names also takes you off items filed earlier, and each one records the change in its history.

Names are matched ignoring case, accents, punctuation and suffixes such as "Inc." or "Ltd", so "Company A, Inc." and "company a" are the same organization. A close but different name (one misspelt word, or extra words) creates a new entry; the Pod merges it with `merge_entities` when they are clearly the same and asks you when it is unsure. A new item that closely matches an open one is reported as a possible duplicate instead of being filed twice.

Search filters by status, people and organizations, assignee, requester, labels and due dates first, then ranks what is left by keyword and meaning together, and the search model drops weak matches. So "the Company A security work" finds the security item from one document and not the Company A pricing item from another. A date without a time is read in the Pod's timezone; due dates mean the end of that day and reminders 9:00. The timezone defaults to UTC; set it with `PUT /api/dots/<id>/policy` and `{ "timezone": "America/New_York" }`. API calls can pass `timezone` instead.

`review_action_items` lists overdue items, items due within three days, reminders that have come due, overdue items others owe you, and items untouched for two weeks. To be reminded regularly, ask a Pod to "review my action items every weekday at 9" and approve the schedule it proposes; scheduled runs record each reminder so it is not repeated.

The same operations are available over HTTP. Send `Content-Type: application/json` on every request that is not a GET.

| Method and path                    | Purpose                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/action-items`            | Search or list. Query: `q`, `entity` (repeatable), `assignee` (`me`, `owed`, `others` or a name), `requester`, `status`, `label`, `dueBefore`, `dueAfter`, `limit`, `timezone` |
| `GET /api/action-items/review`     | The review lists. `?markReminded=true` records reminders as given                                                                                                              |
| `GET /api/action-items/:id`        | One item with its history                                                                                                                                                      |
| `POST /api/action-items`           | Create one item, or `{ "items": [...] }`. Set `"force": true` to file a possible duplicate                                                                                     |
| `PATCH /api/action-items/:id`      | Change fields, `addEntities` or `removeEntities`                                                                                                                               |
| `POST /api/action-items/:id/notes` | Add a note `{ "note": "..." }`                                                                                                                                                 |
| `DELETE /api/action-items/:id`     | Delete an item                                                                                                                                                                 |
| `GET /api/entities`                | List people, organizations, projects and topics. Query: `q`, `kind`                                                                                                            |
| `POST /api/entities/merge`         | Merge `{ "fromEntityId": "...", "intoEntityId": "..." }`                                                                                                                       |

```sh
curl -X POST localhost:4310/api/action-items -H 'Content-Type: application/json' -d '{
  "statement": "Send Company A the revised pricing",
  "context": "Agreed on the renewal call; they need it before their budget meeting",
  "due": "2026-10-20",
  "entities": [{ "name": "Company A", "kind": "organization" }, { "name": "Pricing", "kind": "topic" }]
}'
```

Items live in SQLite and are backed up with it. The Postgres copy is rebuilt automatically: items saved while Postgres is down are indexed before the next search and on start.

Pods handle low-impact work without asking first: filing and updating action items, adding notes, merging entities that are clearly the same, saving memories, and creating a new page in their default Space when a write-up is worth keeping. They tell you what they did. They still ask before sending messages, buying anything, deleting, or editing an existing page, and enforced rules still apply.

### Send to Pod

To have a Pod read something and pick out action items, use **Send to Pod** on a document's page, at the top of a page in a Space, or choose a Pod under **Send to a Pod when ready** when uploading. Add an optional note to say what to focus on. The Pod works on it as a background objective: it reads all of it, files action items with it as the source, and finishes with a short summary of decisions and open questions in a new conversation. An upload that is still being processed waits; the Pod starts once it can be read, and you are notified if processing fails. Only Pods that can read the document, or that work in the page's Space, are offered. Choosing a Pod while uploading grants it access to the new document if the access settings would not.

`POST /api/handoffs` does the same over HTTP: `{ "dotId": "...", "target": { "kind": "document", "documentId": "..." } }` or `{ "kind": "page", "spaceId": "...", "pageId": "..." }`, with an optional `note`. It returns `{ "status": "started", "workItemId": "..." }`, or `{ "status": "waiting", "handoffId": "..." }` while the document is processed.

### Notifications

The app tells you when a Pod finishes background work, cannot finish it, needs your approval, or replies while you are looking at something else. A toast appears in the corner with the start of the Pod's message and an **Open** link to the conversation; it hides after a few seconds and stays in the list under the bell on the icon rail until you open it or mark all as read. Opening a conversation marks its notifications read, and nothing is shown for the conversation you are already watching. While the tab is in the background, the browser shows a system notification instead, if you allowed notifications.

Notifications are stored in SQLite: `GET /api/notifications` (`?unread=1`, `limit`), `POST /api/notifications/:id/read` and `POST /api/notifications/read-all`. Delivery to other places, such as Telegram, email or Slack, plugs in as a `NotificationChannel` on the server's `NotificationService`.

## Pages and page conversations

Select a Space to open its page library. Search for a document, switch between grid and list views, or create a new page. The visual editor supports formatting, headings, lists, checklists, tables, and slash commands. Use `/` to insert a block and Cmd/Ctrl+S to save immediately. Pages autosave after editing pauses; the save status tells you whether changes reached the server.

Page actions include creating subpages, moving a page within its Space, and editing Markdown source. Existing documents with unsupported visual-editor syntax stay in source mode to preserve their content. Manual editing works without model credentials.

Open a page's chat and choose a specialist with access to that Space. Grant access from the Pod’s settings in the sidebar. The server creates or reuses one conversation for that page and specialist. The Pod receives the current saved page as context and can read, create, and edit pages in its authorized Spaces. The page conversation uses that page’s Space by default; other chats use the Pod’s default page destination. Save your manual edits before asking it to revise the document. Revision checks reject stale writes; a conflict keeps your local draft available for recovery. Failed saves stop automatic retries until you retry or resolve the conflict, so a disconnected session does not silently replace newer content.

Use the conversation's save-to-page action to create a document from its saved text history. Pages retain a link to the source conversation, and page links in chat open the document workspace.

Back up the SQLite database (and its `-wal` file, or stop the server first) to back up pages and conversations together. A document can be copied into a page from its detail view. The template does not include multi-user page sharing, realtime collaboration, or arbitrary interactive embeds.

## Browser tool

Parallel is selected by default (`WEB_SEARCH_PROVIDER=parallel`). Live research needs the model configuration, but no browser worker. An optional server-side `PARALLEL_API_KEY` enables authenticated usage and higher limits. The anonymous MCP endpoint is free for light use. Queries, selected URLs, research objectives and a stable session identifier go to Parallel. See [public-web research](../README.md#public-web-research) for data sharing, permissions and limitations.

Set `WEB_SEARCH_PROVIDER=disabled` to turn off these research tools, or `WEB_SEARCH_PROVIDER=browser` for the existing URL-only reader. The browser service reads a supplied public URL and returns page text and a capture. Configure `BROWSER_URL` and `BROWSER_SECRET`, then run:

```sh
npx playwright install chromium
npm run browser
```

Use the same secret on the app and browser processes. Browser navigation is read-only with JavaScript disabled. Private addresses, redirects, and authenticated pages are unsupported; provide a canonical public URL. This is a bounded research tool, not a general desktop or shell.

## Plugins

Plugins give Pods access to external systems. Open **Plugins** on the icon rail, choose an integration, and then decide what each Pod may do with it. Google Calendar is a native integration built into Pods. Linear, Zoho and any custom server connect over remote MCP (streamable HTTP).

Set `PLUGIN_SECRET_KEY` (32 bytes, base64: `openssl rand -base64 32`) to save credentials from the Plugins page. They are encrypted with AES-256-GCM, never returned to the browser, and redacted from tool results and errors. Keep the key stable: changing it makes saved credentials unreadable. Without the key, an MCP plugin can still read its token from a server environment variable.

### Permissions

Each layer can only narrow the one before it, and all of them are enforced on the server:

1. **Provider credential.** The outer limit, chosen at setup: a read-only or team-scoped Linear key, the tools you add to a Zoho MCP server, or the Google scopes you request.
2. **Pinned tools.** Pods records each tool's definition, including its read-only and destructive hints. If the server changes any of them, the plugin stops until you choose **Review and accept**. Pods keep access only to tools that did not change, and new tools start off for every Pod. Each tool is classed as Read, Write or Destructive; a tool without hints counts as Write, and you can override the class.
3. **Per-Pod access.** Each tool is Off, Ask first or Allowed for each Pod. Ask first holds every call, including background work and polls, until you approve it. **Allow read tools** and **All tools, ask before writes** set a Pod's access in one step.
4. **Limits.** For any text parameter, pin one value or list the values a Pod may pass, such as a Linear `teamId` or a Calendar `calendarId`. A pinned value is filled in when the model leaves it out; any other value is refused before the call leaves Pods.
5. **Runtime guards.** Pausing stops plugin calls, consulted Pods cannot use plugin tools, and results are passed to the model as untrusted data.

Each plugin card lists recent calls and approvals, with secrets redacted. Deleting a plugin removes every Pod's access and stops watches that poll it.

### Google Calendar

1. In Google Cloud, enable the Google Calendar API for a project.
2. Configure the OAuth consent screen. Add `calendar.readonly` for read-only access, or `calendar.events` and `calendar.calendarlist.readonly` to let Pods create and change events.
3. Create an OAuth client of type **Web application**. Add `<APP_ORIGIN>/oauth/callback` as a redirect URI, using the first origin in `APP_ORIGIN`. With `npm run dev` this is `http://localhost:5173/oauth/callback`.
4. In Plugins, add Google Calendar, choose the access level, paste the client id and secret, and save. Then choose **Connect** and sign in with the account the Pods should use.

The integration's own settings limit which calendars Pods may use (default `primary`) and which attendee domains they may invite (default: the connected account's domain). They also set whether Google emails attendees about changes (default: never) and whether deletes are allowed (default: off). Pods refreshes the access token automatically. If Google revokes access, the card asks you to reconnect.

Google also offers a Calendar MCP server, but it is in Developer Preview. Pods will reconsider it once it is generally available.

### Linear

Linear's hosted MCP server accepts an API key. In Linear, open **Settings → Security & access**, create a dedicated key, and give it only the permissions and teams the Pods need. Add the Linear plugin and paste the key. Choose the read-only endpoint (`https://mcp.linear.app/mcp/readonly`) for Pods that should never change anything. To let some Pods write while others only read, add a second Linear plugin with its own key.

### Zoho

Create a server at [mcp.zoho.com](https://mcp.zoho.com), or your region's domain (`.eu`, `.in`, `.com.au`, `.jp`), and add only the tools the Pods need. Under **Connection**, choose **Authorization via Connection** and authorize it. The default Authorization on Demand needs a browser sign-in during the first tool call, which background work cannot complete. Copy the server URL from **Connect** and paste it into the Zoho plugin. The URL contains an API key, so Pods stores it encrypted and shows only its host. If it leaks, use **Regenerate API Key** in Zoho and paste the new URL.

### Custom MCP servers

Any remote MCP server over streamable HTTP works with no authentication, a pasted bearer token, or a token read from an environment variable. Plugin URLs must use HTTPS and resolve to public addresses. `http://127.0.0.1` is allowed outside production for local testing. Tools whose full name (`plugin_<id>_<tool>`) would be longer than 64 characters or contain other characters are skipped and listed on the card.

## Persistent Pod computers

For a separate browser, persistent files, and optional shell for each specialist, follow [Computer setup](COMPUTERS.md). This uses pinned OpenBot computer/supervisor services and per-Pod permissions. Parallel research tools remain available alongside configured computer tools. With the browser provider selected, Pods use their computer tools in place of the read-only public-page tool; enable each Pod's required capabilities before use.

## Slack

Slack is not available in this fork yet. Upstream Pods delivered Slack messages through CopilotKit Intelligence Channels, which this fork does not use. The allowlist and message handling in `src/server/slack-channel.ts` are kept for a self-hosted Slack adapter. Until that is wired, `SLACK_*` settings are ignored, the server logs a warning at startup, and Settings & setup reports Slack as unavailable.

## Calls

Calls use [GPT-Live](https://developers.openai.com/api/docs/models/gpt-live-1) at `api.openai.com` by default. Set `VOICE_API_KEY` to a key with GPT-Live access; `VOICE_MODEL` defaults to `gpt-live-1` and `VOICE_NAME` selects the voice (default `willow`). Calls use browser microphone access and WebRTC. Hosted deployments need HTTPS.

A call uses two models. The voice model listens, speaks and decides when it needs help. When it does, it delegates to the server, which turns the owner's words into a short task brief and runs it as a call task: a turn of the selected Pod with the same tools and permissions, in a hidden thread of its own. Each finished task adds a compact exchange (the task, then the full answer) to the conversation, and a call receipt is added when the call ends. Each call allows 20 delegated turns (`VOICE_TASK_LIMIT`, 1 to 100, or `off`) and lasts at most 15 minutes.

- **Briefs and routing.** `FAST_MODEL` (default `gpt-6-luna`; `RERANK_MODEL` when `FAST_MODEL=off`) writes the briefs within about ten seconds; otherwise a templated brief from the owner's words is used. A request with several separate parts becomes up to four tasks under the same delegation, each reported on its own; a follow-up or correction of an open task always stays one task, and `TASK_SPLIT=off` keeps every delegation as one task. At the same time, the Decisions API (`DECISIONS_MODEL`, default `gpt-6-luna`) rates the request, links it to an open task it follows up or corrects, and flags requests too unclear to start, which get a clarifying question instead. Tasks run on `FAST_MODEL` unless they are rated `reasoning` (by Decisions for a single task, by the splitter for each of several); those use `VOICE_TASK_MODEL`, or `OPENAI_MODEL` when unset. A fast task that reports it needs more reasoning is run once more on that model.
- **Parallel tasks.** Up to `VOICE_TASK_CONCURRENCY` tasks (default 3) run at once. A follow-up waits for the task it follows; a correction stops the task it corrects and replaces its result.
- **Results on the call.** A result is passed to the voice model quietly unless the owner is still waiting for it, it failed, or the owner must decide something; then it is spoken at the next pause (`VOICE_QUIET_MS`, default 1000 ms of silence). `VOICE_RESULT_DELIVERY` sets the pacing: `sequential` (default) speaks one result at a time, `batch` combines results that finish together, and `quiet` never pushes a result to speech. Delivery statistics are logged when each call ends.
- **After the call.** Tasks keep running for up to `VOICE_TASK_AFTER_CALL_MS` (default 10 minutes). Their results, and spoken results that were still waiting at hangup, go to the conversation with one notification each, and the receipt lists tasks still running. Pausing Pod stops them. Tasks cut short by a restart are reported in the conversation as interrupted.

The server keeps its own connection to each GPT-Live session for delegated work and the transcript, so the browser only carries audio and captions. Set `VOICE_PROVIDER=realtime` to use the older Realtime API instead; it requires `VOICE_MODEL` (for example `gpt-realtime-2.1`) and runs delegated work through the browser.

A configured key is not evidence of a successful call. Verify microphone access, audio playback, compute delegation, interruption, hangup, and the saved receipt with your deployment before relying on voice workflows.

## Voice notes

A voice note lets you speak a message without starting a call. Press the microphone in the message box, record up to 5 minutes (recording stops on its own at the limit), then listen back and send it or discard it. Cancelling or discarding never reaches the Pod. Voice notes need only `VOICE_API_KEY`; they do not use `VOICE_MODEL` or GPT-Live.

When you send a note, the server forwards the audio to OpenAI's transcription API (`VOICE_TRANSCRIBE_MODEL`, default `gpt-4o-mini-transcribe`) and returns the text. By default the text lands in the message box so you can check or edit it before sending; turn on **Send voice notes right away** in Settings to send it as soon as it is transcribed. Either way it is sent like a typed message, in the same conversation, with the same tools, permissions and approval cards, and it is marked **Voice note** in the timeline. Action items and approvals from a voice note are tracked the same way as from a typed message. If an upload or transcription fails, the recording stays in the browser and **Retry** sends the same audio again; transcription has no side effects, so a retry cannot duplicate a message or an action.

Each Pod's **Reply to voice notes** setting chooses between text only (the default) and text with a spoken reply. With spoken replies, the written answer to a voice note is also read aloud with `VOICE_SPEECH_MODEL` (default `gpt-4o-mini-tts`) in the `VOICE_NAME` voice, and a **Listen** button replays it. The written reply is always kept. Typed messages are answered in text only.

Audio is not stored by Pods. Recordings stay in browser memory until they are transcribed or discarded; the server passes them to OpenAI without writing them to disk, and spoken replies are cached only in the open tab. Only the transcript is saved, as the message in the conversation. Notes can be up to 5 minutes and 10 MB, in WebM, Ogg, MP4, MP3 or WAV. Recording needs microphone access, so hosted deployments need HTTPS.

## Containers

Set `OWNER_TOKEN` and `BROWSER_SECRET` to different random secrets of at least 24 characters in `.env`, and set `POSTGRES_PASSWORD` (`openssl rand -hex 24`), then run:

```sh
docker compose up --build -d
```

Open http://localhost:4310. The app port binds to loopback. The browser service is optional: set a 24+ character `BROWSER_SECRET` and run `docker compose --profile browser up --build` to enable it; it has no published port. Conversations, pages, metadata and uploaded documents live in the `opendots-data` volume; learned memories and search passages live in `opendots-pg`.

Compose also runs Postgres (pgvector) and docling-serve and sets `DATABASE_URL` and `DOCLING_URL` for the app. Neither publishes a port: they share an internal network with the app only, and docling-serve has no route to the internet once its image is built. Setting `DATABASE_URL` or `DOCLING_URL` in `.env` has no effect under compose.

```sh
# Stop services while retaining saved data.
docker compose down
```

For remote hosting, configure an HTTPS reverse proxy and the matching `APP_ORIGIN`. See [Security](../SECURITY.md) for the template's deployment boundary.

## Development checks

```sh
npm run check-format
npm run lint
npm run typecheck
npm test
npm run build
```

Automated tests use service fixtures. Live model and voice verification requires your own configured services.

The Postgres search tests are skipped unless `TEST_DATABASE_URL` points at a disposable pgvector database, for example the one from `compose.dev.yml`:

```sh
TEST_DATABASE_URL=postgres://opendots:<POSTGRES_PASSWORD>@127.0.0.1:5433/opendots npm test
```
