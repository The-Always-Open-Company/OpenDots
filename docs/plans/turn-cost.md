# Turn cost

On 5 November a Zoho Desk and Sprints session on the test server used about
3.65M input tokens over 11 turns, with 22% read from cache. A plain reply in
the main thread cost about 85k tokens; turns that used Zoho tools cost
490k–780k. Two turns hit the 90 second limit and were redone.

## What made turns expensive

- **History filled the budget.** `CONTEXT_MAX_TOKENS` defaulted to 100k, so a
  long thread sent about 70k tokens of history on every model call. The
  main thread sent 475 messages going back to 23 October.
- **Loaded tools never unloaded.** The chat loop rebuilds the loaded tool set
  from every tool search result in the thread, so 49 tools (about 26k tokens)
  went out on every call.
- **Tool search results repeated the schemas.** A search result carries each
  loaded tool's full schema, and the tool list then sends them again. Zoho
  searches returned 19k–41k characters each.
- **Plugin results reached the model escaped.** MCP returns JSON as text, which
  the model read with every quote escaped, at about twice the size. Results
  had no size limit; one `GetProjects` call returned 129k characters.
- **A 90 second clock stopped turns mid-work**, and the next turn redid the
  same lookups.
- **The model repeated calls that had failed**, for example `include:
  ["departments"]` on Zoho Desk.

## Measuring

Every turn now writes a row to `turn_usage` (`src/server/turn-usage.ts`),
however it ends:
- its model calls, with billed input, cached, output and reasoning tokens
- the size of each request: system prompt, history, and tools
- every tool call, with its result size
- how the turn ended

`GET /api/usage?hours=24` returns totals by kind and model, and the turns
themselves.

`npm run replay` replays turns against a snapshot of a real database, with no
model or plugin involved (`scripts/replay.ts`). It has two modes:
- **Plain turn:** sends a plain message on a thread.
- **Recorded run:** replays a recorded run. A scripted model repeats the run's
  tool calls round by round, and every tool returns its recorded result.

Plugin calls still pass through authorization, approvals and result limits. If
a tool the run used is no longer loaded, the scripted model searches for it
first, as a real model would.

Estimates count four characters per token. On these runs they come out about
12% above the billed tokens: 765k against 681k billed, and 254k against 246k.
`scripts/replay-scenarios.json` holds the 5 November threads; run it against a
snapshot of the test server taken on or after that date.

## Changes

1. **History budget 40k** (`DEFAULT_CONTEXT_MAX_TOKENS`). Older turns are
   summarized, or dropped if summarizing fails. Set `CONTEXT_MAX_TOKENS` to
   change it. At 25k one replay kept only 3 history messages, which is too
   few.
2. **Tools unload after two turns** (`unloadEarlierTools`). Search results from
   before the last two user turns are replaced, for the model only, by the
   names they loaded. The model searches again when it needs one of those
   tools, at the cost of one small round.
3. **Search results as names** (`toolSearchMiddleware`). The model sees each
   tool search result as the names it loaded; the schemas are already in the
   tool list. Stored results are unchanged.
4. **Plugin results unpacked and limited** (`limitPluginResults`). JSON
   returned as text is unpacked, and anything over 24,000 characters is cut,
   with a note asking the model to narrow the request. The harness records
   the full result first.
5. **No clock.** The 90 second chat limit, the background job limit and the
   chat task limit are gone. In their place:
   - **A cap on model calls per turn:** 40 by default (`MAX_AGENT_TURNS`,
     `off` for none). The last allowed call must answer in text.
   - **No repeats of a failed call:** an identical call that already failed
     in the turn is not run again; the model is told to change it.
   - **Stop when stuck:** after three model calls in a row whose tool calls
     all failed, the next call must answer in text and say what failed.
   - **Plugin network calls** keep their 30 second timeout.

   Tasks started during a live voice call (`VOICE_PROVIDER=live`) have no
   clock either. They run in the background while the voice agent keeps
   talking, up to 3 at once, and results are spoken at pauses. Still timed:
   - the older `realtime` provider's `ask_compute`, at 90 seconds, because
     the voice model waits on that one call;
   - consultations with another Pod, because the asking Pod waits on the
     answer.

   Tasks still running when a call ends carry on until they finish, and
   post their results to the chat. `VOICE_TASK_AFTER_CALL_MS` is gone.

## Results

Replayed on the test server's database from 5 November. The figures are
estimated input tokens for the whole turn.

| Scenario | Before | After |
|---|---|---|
| Main thread, plain reply | 98k | 29k |
| Zoho: "try again" (hit 90s) | 895k | 351k |
| Zoho: "please continue" (681k billed) | 765k | 329k |
| Zoho: ticket link and #P112 (hit 90s) | – | 323k |
| Zoho: continue to create (778k billed) | 876k | 361k |
| Zoho: Sprints item (761k billed) | 854k | 360k |
| Cliq summary job (246k billed) | 254k | 218k |

## Not done yet

- **Prompt caching.** History is trimmed from the oldest end, so the start of
  each request changes from turn to turn. Trimming in larger steps would keep
  the start stable between turns.
- **OpenAI's hosted tool search** (`tool_search` with `defer_loading`), to
  try behind a setting once the adapter can send it.
- **The `maxExecutionMs` policy field** is no longer enforced. It is still
  stored and editable.
