# Slim prompts and stop wasted work retries

This plan covers the four problems found in Chloe's 30 October summary job and the instruction review that followed. It does not cover the call issues filed as OPE-7 through OPE-11, or the output-token and 90-second cutoff in OPE-18.

On that job, one objective made about 103 model rounds across 20 attempts. The first attempt searched for five minutes and was cut off. The second saved the summary. The next 18 only repeated "this is already done" because one Cliq read was left uncertain. Fifty-two of the lookups were action-item searches, mostly the next page of the same search.

The work is three groups, built in this order.

- **Group A, prompt and tool efficiency** (sections 1, 2, 4). Fewer tokens and fewer model rounds.
- **Group B1, read/write classification** (section 3a). Small. On its own it would have stopped the 18 extra attempts.
- **Group B2, evidence and progress** (sections 3b to 3e and 5). Needs the read log first.

## Decisions

- **No blocked state for the owner to resolve.** When a job cannot get something it needs, it finishes and its report names the gap, for example "Today's Cliq messages could not be read, so this summary may miss anything from #sales." The owner is not asked to act. When an agent started the job as a child, the gap appears in the parent's final report. When the owner started it, it appears in the job's own report.
- **Scheduled jobs start clean on each run.** Evidence, unresolved reads and the "records already seen" set belong to one run, not to the job's lifetime. A gap on Monday is reported Monday and does not hold Tuesday open.
- **Jobs open at deploy finish under the old rules.** A job created before this change is treated as having declared no sources, so its completion request is not rejected.
- **An uncertain write is reported, not retried.** No integration tells the harness how to confirm a write today. A write that may or may not have happened is never repeated and never starts another full attempt. The job finishes and the report says "I tried to do X and cannot confirm it went through. Please check." Automatic read-back is deferred until a specific integration needs it.

## Answers the review asked for

**Action items.** Pods do not create action items merely because a conversation or document mentions work. They create or change them when the owner asks for task tracking, or when an established workflow requires it. Handing a document or page to a Pod (`handoffs.ts`) is such a workflow.

**Document retrieval.** It runs once per agent run, not on every model round. A background attempt is one run, so a retried job pays for planning, embedding and reranking once per attempt. This change does not remove that pipeline. It measures it (see Measurement).

**complete_work.** It means the Pod claims the objective is achieved. Today the harness treats it both as that claim and as a request that does not carry to the next attempt. That mix is why one clean summary plus one stuck read produced 18 more attempts.

**Required sources.** A job does not name them. The Pod picks Cliq, action items or documents while working, so the harness cannot tell a required lookup from an optional one by reading the objective.

**Tool-free objectives.** A Pod can finish without calling a tool: a poem, an explanation, a draft from context in the thread. An explicit empty declaration separates that case from a Pod that never considered its sources.

## 1. Action-item rules become a skill

Current. When action items are configured, `capabilityContext` appends `ACTION_ITEM_PROMPT` to the cached system prompt on every chat, call and background turn, and the main prompt in `dot-agent.ts` says to file and update action items without asking. Those rules file a to-do from anything the owner shares.

Change.

- Remove `ACTION_ITEM_PROMPT` from `capabilityContext`.
- Replace the proactive action-item wording in `dot-agent.ts` with this boundary: use action items when the owner asks for task tracking or an established workflow requires it; load the action-items skill before creating or changing them; do not create them merely because a conversation or document mentions work.
- Keep memories, notes and saving a write-up as a page in the proactive sentence.
- Add a built-in `action-items` skill whose body covers statement quality, tags, duplicates, entity merges, searching before answering, updates when status changes, and the period filters from section 4. It is listed in the skill catalog whenever action items are configured, with no per-Pod grant, and `load_skill` returns it. A skill of the same name in `SKILLS_DIR` does not replace it.
- The handoff steps tell the Pod to load the action-items skill before filing.
- Leave the action-item tools available.

## 2. Shared documents leave the standing instructions

Current. `describeCatalog` pastes up to 40 shared documents (about 8,000 characters) into the system prompt on every turn with a library. `list_documents` already returns that directory but is lazy.

Change.

- Stop calling `describeCatalog` from the system prompt, including the empty-catalog sentence.
- Keep `describePassages` for passages retrieved for this message.
- Make `list_documents` eager. Add one sentence: a document library is available through `list_documents` and `search_documents`; do not claim a document exists unless a tool returned it.

## 3. Effect reconciliation is not objective success

### 3a. Read/write classification (Group B1)

Current. Every `plugin_*` call is recorded as an effect whatever its access (`isEffect` in `work-tools.ts`). A thrown call is `failed` only when the tool is idempotent or the error is a `PluginToolError`; otherwise it is `uncertain`. A call still started when an attempt is cut off becomes `uncertain`. Any `started` or `uncertain` row holds the job open for its lifetime.

Change.

- Classify each plugin tool, in order: the existing per-tool override (`plugin_tools.access`, set from the admin UI), then annotations (`readOnlyHint`, `destructiveHint`), then a name fallback (`list_`, `get_`, `search_`, `read_`) only when annotations are absent. The name fallback never applies to built-in tools. Store which of `override`, `annotation` or `name` decided it, so a wrong call can be traced.
- `guardTools` uses that classification. A read that throws or is cut off is `failed`, never `uncertain`, and does not hold the job open.
- After this ships, migrate existing `uncertain` and `started` rows to `failed` only for tools now classified as reads. Leave uncertain writes alone.
- For scheduled jobs, unresolved rows count only for the current run.

### 3b. Read log

Requirements need something to point at, and built-in reads (`search_action_items`, `search_documents`, `list_documents`) are not recorded today. Add a small log of every tool call in a background run: invocation id, run, tool name, arguments, status, result count when the result has one, and a hash of the result. Effects keep their existing table; the log references it when a call is also an effect.

### 3c. Evidence record

- `declare_requirements` records the sources the Pod needs. An empty list means no external evidence is needed. `complete_work` also accepts the declaration inline, so a simple job does not spend a round on it.
- Each row has a key, a label, a tool name, argument constraints and a status: `pending`, `satisfied`, `withdrawn` or `superseded`. The Pod may add rows later, and may withdraw or supersede one with a reason. Withdrawn and superseded rows do not block.
- **Scope matching.** A row is satisfied by a successful logged call to the same tool whose arguments equal the row's constraints on every key the row names. Keys the row does not name are ignored. An empty result satisfies the row. The Pod cannot satisfy a row in prose.
- `complete_work` with no declaration is rejected inside the same attempt, not by queuing another. After three rejections in one attempt the attempt ends and the job finishes with that gap reported.

### 3d. Objective outcome

`complete_work` closes the job as completed when the attempt ends cleanly, a declaration exists, every active row is satisfied and no write is uncertain.

Otherwise, once the Pod has asked to complete, the job still finishes. Each pending or failed requirement and each uncertain write becomes a gap: a short line saying what is missing and why. Gaps are stored on the job, must appear in the final report, and are copied into the parent's report when the job is a child. The harness does not invent sources the Pod never declared, and does not grade the written answer.

### 3e. Reconciliation

`record_reconciliation` may settle an uncertain write only by citing a successful logged read in the same job. A sentence alone no longer settles it. An uncertain write that is not settled within the attempt that made it becomes a gap. It does not start another normal attempt.

## 4. Several searches in one reply

Current. `search_action_items` takes one query, at most 20 items, and tells the Pod to page with `nextOffset`. On the summary job the Pod spent most rounds deciding the next page.

Change.

- `search_action_items` accepts up to five searches in one call. A single search is a list of one (see Measurement results for why the flat form was dropped).
- Cap each search at 50 results and the call at 100. When the requested total passes 100, scale each search's limit in proportion, with at least one slot each. Each result reports requested, returned, whether it was cut, and its own `nextOffset`.
- Results are compact by default (statement, status, dates, people). Full detail stays on `read_action_item`.
- Add period filters: created in, completed in, updated in, and still outstanding. Periods are read in the owner's time zone. The skill tells the Pod to use them instead of paging a broad search.
- One standing sentence: when lookups do not depend on each other, ask for them all in the same reply.
- Plugin schemas do not change.

## 5. Retry only when another attempt can help

Progress between attempts, compared from the read log and the job's state:

- a read returns records this run has not seen (by result hash);
- a new artifact is saved;
- an uncertain write is settled;
- an active requirement becomes satisfied;
- a previously unfinished step finishes, even with no new records.

The same tool with the same arguments and the same result does not count. Editing the progress text, loading a skill, or rereading evidence already in the thread does not count.

Rules:

- A read hits a rate limit with a retry delay: queue the retry for after that delay, once. Do not wait inside the tool call, which would spend the attempt's time budget.
- A read times out or the connection drops: retry once with a short backoff, then stop and record a gap.
- A read fails permanently: do not retry; record a gap if it was declared.
- A write is uncertain: see 3e.
- A valid completion request: close the job (3d).
- The attempt timed out: the next attempt continues in the same thread and is told which operations already finished, so it does not repeat them.
- Two attempts in a row with no valid completion request and no progress: finish the job with a gap saying the work stopped making progress.

This check is a backstop. Closing a job still depends on 3c and 3d.

## Tests

- A turn with action items configured includes the boundary and not `ACTION_ITEM_PROMPT`. `load_skill('action-items')` returns the rules without a grant.
- A turn with a library has no catalog JSON. `list_documents` is eager and is not called unless the model calls it. Retrieved passages are still included.
- A plugin read with no `readOnlyHint` is classified by override or name, with the source stored. A read that throws is `failed` and does not hold the job open. Migration clears only uncertain reads.
- `complete_work` with no declaration is rejected in the same attempt. An explicit empty declaration allows completion with no tool calls. A withdrawn requirement does not block.
- A requirement is satisfied by a logged call with matching constraints, including an empty result, and not by the same tool with different constraints.
- A declared read that fails finishes the job with a gap, not as fully completed, and the gap appears in the parent's report for a child job.
- A non-idempotent write that throws stays uncertain, is not retried, and finishes the job with a gap instead of queuing attempts.
- A scheduled job's uncertain read on one run does not hold the next run open.
- A job created before the change can complete without a declaration.
- One `search_action_items` call with five searches of 50 returns at most 100 compact records, split in proportion, each with its own truncation flag and `nextOffset`.
- A timed-out attempt that already saved a page does not repeat that write.
- Two attempts that repeat the same search with no completion request finish with a gap. An attempt that reasons over existing evidence and then completes validly closes normally.

## Measurement

On a fixture shaped like the summary job, record before and after: model rounds, input and output tokens, document-retrieval calls per attempt (planner, embedding, rerank), and whether the objective completed, completed with gaps, or falsely reported success.

## As built

Notes where the implementation differs from or adds to the sections above.

- **Name fallback (3a).** The name rule splits on underscores, dashes and capitals, accepts `list`, `get`, `search`, `read`, `fetch`, `find`, `query` and `lookup` among the first three words, and treats any write word (`send`, `mark`, `update` and similar) as a write. Classification only decides what a failure means. Approval defaults still come from the access column and annotations, so a name never lets a tool run without asking.
- **Read log (3b).** `tool_calls` in `evidence.ts` logs every call in a background attempt except the tools that manage the run (`complete_work`, `declare_requirements`, `load_skill` and similar).
- **Scope matching (3c).** String constraints match after trimming and ignoring case. A source declared after its call already ran is satisfied at once.
- **Undeclared completion (3c).** The third refusal in one attempt records completion with a gap saying the sources were never named.
- **Outcome (3d).** A job that claims completion closes as `completed` with its gaps stored on the work item (`gapsJson`). The report appends them under "What may be missing". A parent's next prompt lists its children's gaps. A write that definitely failed in the claiming attempt still gets another attempt, as before.
- **Reconciliation (3e).** `record_reconciliation` needs `checkedWith`, naming a read tool with a successful logged call in the same job after the write started.
- **Retries (5).** A read that times out or loses its connection is retried once after one second. A rate limit is waited out once inside the call only when it asks for 30 seconds or less; a longer one fails the read and becomes a gap, rather than queuing a delayed attempt. A job that stalls is marked `failed` with a gap saying it stopped making progress.

## Measurement results

`npm run measure:summary -- [recovers|down] [--json]` runs `scripts/measure-summary-job.ts`. It drives the real agent, engine, plugin service and tools through a job shaped like the summary job. The setup is:

- 40 shared documents and 300 action items, 100 of them from today.
- A Cliq read that hangs until the first attempt hits its time limit.
- After that, Cliq either answers (`recovers`) or keeps failing with a 503 (`down`).

The model is scripted. It uses batched searches and declares its sources when the tool schemas allow it, and pages one search at 20 items otherwise. Round counts show what each version lets a model do. Prompt sizes are measured from the real requests and converted to tokens at four characters each. Output tokens are not measured.

Results on 1 November 2026, main (`b3bd035`) against this branch:

|                                                       | main, recovers   | branch, recovers | main, down                        | branch, down                  |
| ----------------------------------------------------- | ---------------- | ---------------- | --------------------------------- | ----------------------------- |
| Outcome                                               | still open       | completed        | still open, failure not mentioned | completed, Cliq gap in report |
| Attempts                                              | 20 (attempt cap) | 2                | 20 (attempt cap)                  | 2                             |
| Model rounds                                          | 56               | 6                | 57                                | 7                             |
| Input tokens, whole job                               | ~1,252,000       | ~61,000          | ~1,296,000                        | ~72,000                       |
| Action-item search calls                              | 15               | 1                | 15                                | 1                             |
| Document retrievals (planner, embedding, rerank each) | 20               | 2                | 20                                | 2                             |

Retrieval still runs once per attempt. It falls with the number of attempts.

First-round prompt: system prompt 3,834 → 1,053 tokens, tool schemas 4,215 → 5,063 tokens, total 8,243 → 6,310 (-23%). The tool schemas grew by:

- `search_action_items`: 555 → 737 tokens. A first version took a single search's fields directly and again inside `searches`, which came to 2,125 tokens. The tool now takes only `searches`, states the period rule once in its description, and offers the date bounds as ISO strings only.
- `complete_work`: 110 → 319 tokens, because of inline sources.
- `declare_requirements`: a new tool of 384 tokens, now eager.
- `list_documents`: 102 tokens, now eager.

Found while measuring: when an attempt is cut off during a tool call, the agent runtime runs that call again at the start of the next attempt, before the model sees anything. The call is still left without a result in the thread history, so this happens outside the model's control. For a read, this is the retry the job needs. Whether a cut-off write would be sent twice this way has not been tested yet.
