# Running the template

OpenDots runs a React app and a Node server. The server stores pages, Space and Dot configuration, and full conversation history in SQLite, and connects to your configured model and speech services.

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

Summaries use `SUMMARY_MODEL`, which defaults to `OPENAI_MODEL`. Stored history is never rewritten; compaction affects only what is sent to the model.

### Turn limit

A reply can take several model turns: each turn may call tools, and the next turn reads their results. `MAX_AGENT_TURNS` caps those turns per reply. It is off by default, so a reply continues until the model answers or the 90-second reply time limit is reached. When a limit is set, the last allowed turn cannot call tools and must answer from what was already found.

### Connection settings

Edit `.env` on the server and restart after changes:

| Variable                         | Purpose                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Model credential and model identifier                              |
| `OPENAI_BASE_URL`                | Compatible model API endpoint                                      |
| `CONTEXT_MAX_TOKENS`             | Estimated token budget for history sent to the model               |
| `SUMMARY_MODEL`                  | Model for summaries of older turns; defaults to the model          |
| `MAX_AGENT_TURNS`                | Model turns per reply, 2–100; unset or `off` means no limit        |
| `OWNER_ID`                       | Stable identity used for this deployment's conversations           |
| `DATABASE_PATH`                  | SQLite file containing conversations, pages, and metadata          |
| `OWNER_TOKEN`                    | Application access token; required for external bindings           |
| `APP_ORIGIN`                     | Comma-separated exact browser origins for a proxy or custom domain |

Provider credentials belong in `.env`, not client-side variables or source code. CopilotKit and mem0 telemetry are disabled in code; no telemetry setting is needed.

## Memory and documents

Learned memory and the document library need two extra services: Postgres with pgvector, and docling-serve for converting files. Both are optional. Without them, chat and pages work as before; the Memory screen and Documents explorer say what is missing.

| Variable                       | Purpose                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`            | Password for the bundled Postgres service. Generate with `openssl rand -hex 24` |
| `DATABASE_URL`                 | Postgres with pgvector. Enables learned memory and document search              |
| `DOCLING_URL`                  | docling-serve endpoint. With `DATABASE_URL`, enables document uploads           |
| `EMBEDDING_MODEL`              | Embedding model; defaults to `text-embedding-3-small` (1536 dimensions)         |
| `MEMORY_MODEL`                 | Model that extracts memories from turns; defaults to `OPENAI_MODEL`             |
| `ENRICHMENT_MODEL`             | Model that writes summaries, tags and passage context; defaults to the model    |
| `RERANK_MODEL`                 | Model that plans searches and reranks passages; defaults to `OPENAI_MODEL`      |
| `DOCUMENTS_DIR`                | Where original and converted files are kept; defaults next to the database      |
| `MAX_UPLOAD_MB`                | Largest accepted file, 1–2000 MB; default 50                                    |
| `DOCLING_MAX_DOCUMENT_TIMEOUT` | Seconds docling-serve may spend on one file (compose only); default 900         |

Embeddings and memory extraction use `OPENAI_API_KEY` and `OPENAI_BASE_URL`, so a custom endpoint must also serve `/embeddings` with a 1536-dimension model. SQLite remains the source of truth for documents, grants and Space links; Postgres holds only searchable data (memory vectors and document passages). Changing who can read a document takes effect immediately without re-indexing.

For `npm run dev`, run the two services on loopback with the development compose file, then set the URLs in `.env`:

```sh
docker compose -f compose.dev.yml up -d
# .env
# DATABASE_URL=postgres://opendots:<POSTGRES_PASSWORD>@127.0.0.1:5433/opendots
# DOCLING_URL=http://127.0.0.1:5001
```

Both compose files build a small layer on the docling-serve image that downloads the tokenizer its chunker needs, so docling-serve never fetches models at runtime. The base image is several gigabytes, so the first build takes a while and needs internet access; later starts do not. Run `docker compose build --pull docling` to pick up a newer docling-serve release.

### Memory

The Memory screen has two parts. **About me** holds preferences you write yourself; every Dot with memory enabled sees them. **Learned by each Dot** lists facts each Dot picked up from its own conversations, which you can edit or delete. After a turn finishes, the Dot's memory model reads what you said and its reply (never tool output, web pages or documents) and stores durable facts for that Dot only. Before each turn, the Dot recalls the learned memories most relevant to your latest message. Dots can also save a fact when you ask them to remember something.

Turn memory off per Dot or for the whole workspace in Settings. Turning it off stops both recall and learning.

### Asking another Dot

A Dot can ask another Dot a question with its `ask_dot` tool. The answer comes from the other Dot's own memories, documents and Spaces. Consultations run in a separate conversation per pair of Dots, are limited to one level (a consulted Dot cannot consult further) and to 45 seconds, and the consulted Dot cannot edit pages, save memories or use its computer. Clear **Other Dots can consult this Dot** in a Dot's settings to opt it out.

### Documents

Open **Documents** in the sidebar to browse, search and upload. When uploading, choose which Dots can read the file: none directly, specific Dots, or all Dots (including ones you add later). Linking a document to a Space also lets every Dot that works in that Space read it. Spaces show their linked documents below the page list, with **Upload** and **Link existing**.

Supported files are PDF, Word, PowerPoint, Excel, HTML, Markdown, text, CSV, PNG and JPEG; the server checks the content matches the extension. Uploads are converted in the background, one at a time. A document becomes searchable once it shows **Ready**. Uploading a new version keeps the previous one searchable until the new one finishes. Uploading identical content again shares the existing document instead of indexing it twice.

Attach files in chat with the paperclip. Attachments are saved to the library, shared with the Dot you are talking to, and linked to the page's Space when the chat is about a page. The message waits until each attachment is ready.

#### How documents are indexed

docling splits each file into passages of about 512 tokens along its headings and tables. The enrichment model then reads the document and writes:

- a short summary, topic tags and the main names it mentions (shown on the document page and used to filter the library);
- for each passage, one or two sentences placing it in the document, plus keywords and names ([contextual retrieval](https://www.anthropic.com/news/contextual-retrieval)). Passages are sent in batches by section, four calls at a time.

Each passage is embedded together with the document title, its section and that context, and indexed for keyword search with headings and keywords weighted highest. Passages are linked to the most similar passages and to passages that name the same things, in any document. If an enrichment call fails, those passages keep their headings only; the document still becomes **Ready** and its page notes the partial enrichment. **Reprocess** retries.

When indexing changes in an update, documents indexed the old way are re-indexed automatically on start. They stay searchable while that runs, and docling is not run again.

#### How Dots search

Before each reply, the search model plans the search from the latest message, the recent conversation and the Dot's catalog of documents. It writes a self-contained question (so "what about the second one?" works), three to five varied queries, a hypothetical answer, and related tags. Every query runs as a keyword and semantic search, the tags match passage keywords and names, and the results are merged with reciprocal rank fusion. The search model then scores the top 40 for relevance. The best six are kept, with at most three per document and two per section, and each comes with its neighbouring passages and references to related passages. Greetings and small talk skip the search. If the search model is slow or fails, plain search of the message is used.

Dots can also call `list_documents`, `search_documents` (the same pipeline for a query of their own, optionally limited to documents or tags), `read_passage` (to open a related passage) and `read_document`. Each call checks the Dot's current access, and related passages from documents the Dot cannot read are never shown.

Searching adds two model calls to each turn that involves documents, usually one to three seconds; a small, fast `RERANK_MODEL` keeps this low. Indexing costs one call for the document and one per eight passages.

Back up `DOCUMENTS_DIR` together with the SQLite database. The Postgres data can be rebuilt by reprocessing documents, but learned memories live only in Postgres, so back up its volume too.

## Pages and page conversations

Select a Space to open its page library. Search for a document, switch between grid and list views, or create a new page. The visual editor supports formatting, headings, lists, checklists, tables, and slash commands. Use `/` to insert a block and Cmd/Ctrl+S to save immediately. Pages autosave after editing pauses; the save status tells you whether changes reached the server.

Page actions include creating subpages, moving a page within its Space, and editing Markdown source. Existing documents with unsupported visual-editor syntax stay in source mode to preserve their content. Manual editing works without model credentials.

Open a page's chat and choose a specialist with access to that Space. Grant access from the Dot’s settings in the sidebar. The server creates or reuses one conversation for that page and specialist. The Dot receives the current saved page as context and can read, create, and edit pages in its authorized Spaces. The page conversation uses that page’s Space by default; other chats use the Dot’s default page destination. Save your manual edits before asking it to revise the document. Revision checks reject stale writes; a conflict keeps your local draft available for recovery. Failed saves stop automatic retries until you retry or resolve the conflict, so a disconnected session does not silently replace newer content.

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

## Persistent Dot computers

For a separate browser, persistent files, and optional shell for each specialist, follow [Computer setup](COMPUTERS.md). This uses pinned OpenBot computer/supervisor services and per-Dot permissions. Parallel research tools remain available alongside configured computer tools. With the browser provider selected, Dots use their computer tools in place of the read-only public-page tool; enable each Dot's required capabilities before use.

## Slack

Slack is not available in this fork yet. Upstream OpenDots delivered Slack messages through CopilotKit Intelligence Channels, which this fork does not use. The allowlist and message handling in `src/server/slack-channel.ts` are kept for a self-hosted Slack adapter. Until that is wired, `SLACK_*` settings are ignored, the server logs a warning at startup, and Settings & setup reports Slack as unavailable.

## Calls

The included speech adapter uses the Realtime API at `api.openai.com`. Set `VOICE_API_KEY` to a key with access to that API and `VOICE_MODEL` to a supported Realtime model (the local UI test used `gpt-realtime-2.1`); `VOICE_NAME` selects the voice. `OPENAI_BASE_URL` changes the compute model endpoint only, not speech. Calls use browser microphone access and WebRTC. Hosted deployments need HTTPS. The server mediates provider setup and delegates compute to the selected Dot's conversation.

A configured key is not evidence of a successful call. Verify microphone access, audio playback, compute delegation, interruption, hangup, and the saved receipt with your deployment before relying on voice workflows.

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
