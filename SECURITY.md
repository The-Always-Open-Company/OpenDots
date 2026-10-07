# Security

OpenDots is an application template under development, not a hosted service. The local prototype is single-owner; Space membership, Slack identity mapping, and voice delegation require additional enforcement before connected multi-user use. It is not a security-audited autonomous agent.

## Intended boundary

- Run local development on loopback.
- Protect remote deployments with authentication and HTTPS.
- Keep the browser service isolated from the application host and private networks. Do not expose its port publicly.
- Keep model, speech, and browser credentials on the server. Never commit `.env` files or local databases.
- Treat page text, uploaded content, and model output as untrusted data, not authorization to change permissions.
- Authorize every Space, Dot, and thread operation on the server. Map Slack actors explicitly; never treat a display name or client-supplied user ID as proof of identity.
- Voice sessions must use scoped, short-lived credentials and route compute actions through the same permissions as text and Slack.
- Research browsing is read-only. Page tools can edit local documents in the executing Dot’s Space; those writes use revision checks. Adding external writes requires a separate authorization and review design.

## Memory, consultations and documents

- **Learned memories are per Dot.** Each memory is stored with the owner and Dot it belongs to, and every read, edit and delete checks both. Extraction reads only the user's messages and the Dot's reply in chat threads, never tool output, web pages, documents or consultation threads, to limit prompt-injection into long-term memory. Memories are sent to the model provider with each turn and to the memory model when extracting; do not tell Dots secrets.
- **Consultations are server-side only.** A consulted Dot answers in its own consultation thread with its own permissions, minus page edits, memory writes, computer tools and page review. Questions and answers are marked as untrusted. Depth is limited to one and each consultation to 45 seconds. The browser runtime refuses consultation threads; review them through `/api/consultations`. A consulted Dot can still reveal what it can read, so opt sensitive Dots out with **Other Dots can consult this Dot**.
- **Document access is resolved in SQLite on every call.** Search passes only the IDs a Dot may read to Postgres and re-checks the results; reading checks again. Revoking a grant, unlinking a Space or removing a Dot from a Space takes effect on the next tool call. Links between related passages span documents, so every neighbour and related reference is filtered by the reading Dot's access again before it is shown. Document text is untrusted content and is presented to the model as data.
- **Indexing and search send document text to the model provider.** Enrichment sends each document's opening text and each section to `ENRICHMENT_MODEL` to write summaries, tags and passage context. Each search sends the recent conversation, the titles, summaries and tags of documents the Dot can read, and up to 40 candidate passages to `RERANK_MODEL`. Both use `OPENAI_BASE_URL`; point it at an on-prem model to keep documents in-house. The prompts treat document text as data, but a document crafted to manipulate its summary or ranking can still influence what a Dot is shown.
- **Uploads are checked and never rendered.** The server accepts a fixed list of extensions, checks the content against the extension, enforces `MAX_UPLOAD_MB`, and stores files under random IDs. Downloads are sent as `application/octet-stream` attachments with a sandboxing Content-Security-Policy, so an uploaded HTML file cannot run on the app's origin. Converted text is shown as plain text.
- **Postgres and docling-serve are internal.** Under compose they share an internal network with the app, publish no ports, and docling-serve has no route to the internet. Uploaded files are parsed by docling-serve; rebuild it regularly (`docker compose build --pull docling`), since document parsers are a common attack surface.

Recurring work requires an available server. A sample run is not evidence that a live provider or deployment is safe or configured correctly. Review results before using them for important decisions.

## Reporting

Use the repository's private vulnerability reporting feature when available. If it is unavailable, open an issue asking for a private reporting channel without including exploit details, credentials, private URLs, or personal data.

Do not post sensitive reproduction data in a public issue. This project does not currently promise a response-time SLA or offer a bug bounty.
