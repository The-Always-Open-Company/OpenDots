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

### Connection settings

Edit `.env` on the server and restart after changes:

| Variable                         | Purpose                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Model credential and model identifier                              |
| `OPENAI_BASE_URL`                | Compatible model API endpoint                                      |
| `CONTEXT_MAX_TOKENS`             | Estimated token budget for history sent to the model               |
| `SUMMARY_MODEL`                  | Model for summaries of older turns; defaults to the model          |
| `OWNER_ID`                       | Stable identity used for this deployment's conversations           |
| `DATABASE_PATH`                  | SQLite file containing conversations, pages, and metadata          |
| `OWNER_TOKEN`                    | Application access token; required for external bindings           |
| `APP_ORIGIN`                     | Comma-separated exact browser origins for a proxy or custom domain |

Provider credentials belong in `.env`, not client-side variables or source code. CopilotKit's runtime telemetry is disabled in code; no telemetry setting is needed.

## Pages and page conversations

Select a Space to open its page library. Search for a document, switch between grid and list views, or create a new page. The visual editor supports formatting, headings, lists, checklists, tables, and slash commands. Use `/` to insert a block and Cmd/Ctrl+S to save immediately. Pages autosave after editing pauses; the save status tells you whether changes reached the server.

Page actions include creating subpages, moving a page within its Space, and editing Markdown source. Existing documents with unsupported visual-editor syntax stay in source mode to preserve their content. Manual editing works without model credentials.

Open a page's chat and choose a specialist with access to that Space. Grant access from the Dot’s settings in the sidebar. The server creates or reuses one conversation for that page and specialist. The Dot receives the current saved page as context and can read, create, and edit pages in its authorized Spaces. The page conversation uses that page’s Space by default; other chats use the Dot’s default page destination. Save your manual edits before asking it to revise the document. Revision checks reject stale writes; a conflict keeps your local draft available for recovery. Failed saves stop automatic retries until you retry or resolve the conflict, so a disconnected session does not silently replace newer content.

Use the conversation's save-to-page action to create a document from its saved text history. Pages retain a link to the source conversation, and page links in chat open the document workspace.

Back up the SQLite database (and its `-wal` file, or stop the server first) to back up pages and conversations together. The template does not include multi-user page sharing, realtime collaboration, file uploads, or arbitrary interactive embeds.

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

Set `OWNER_TOKEN` and `BROWSER_SECRET` to different random secrets of at least 24 characters in `.env`, then run:

```sh
docker compose up --build -d
```

Open http://localhost:4310. The app port binds to loopback. The browser service is optional: set a 24+ character `BROWSER_SECRET` and run `docker compose --profile browser up --build` to enable it; it has no published port. Conversations, pages, and metadata live in the `opendots-data` volume.

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
