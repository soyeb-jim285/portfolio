# Soyeb Pervez Jim, portfolio

Astro 7 static site. Twelve pages drawn as a seven-sheet engineering set: title, work, research, parts list, a detail sheet per project (5.1 to 5.7), record, contact.

## Run

```sh
npm install
npm run dev        # frontend :4321 + API :3001 (requires both .env files)
npm run dev:site   # frontend only
npm run dev:api    # API only
npm run build      # dist/
npm run preview
```

## Content

Everything visible comes from `src/data/content.ts`. Numbers there are sourced in `src/data/cv.json`, which records where each fact came from. Edit `content.ts`, not the pages.

## Contact form

`src/components/ContactDialog.astro` posts JSON to `PUBLIC_FORM_ENDPOINT`. Create a form at formspree.io (or any endpoint that accepts JSON and returns 2xx), then:

```sh
cp .env.example .env   # and paste the endpoint URL
```

Without an endpoint the form falls back to opening the mail client with the message prefilled.

## Portfolio assistant (initial integration)

The site includes a slim full-height assistant side panel, docked beside the page on wide screens and a bottom drawer on mobile. Questions can be typed or recorded: a voice note is transcribed once through OpenRouter, the audio and transcript stay in the browser, and only the text reaches the chat model. Its left edge is a drag handle (also arrow keys when focused, double-click to reset); the width is clamped to 340-760px, kept inside the viewport on resize, and remembered per browser in `localStorage`. It uses an Astro-persisted React island, adapted shadcn Sheet/Button and AI Elements Message components, styled with the portfolio's navy/orange theme. A separate Node.js 22+ Hono API streams answers from OpenRouter using explicitly selected public portfolio fields, stores each anonymous conversation in PostgreSQL, answers code questions from an index of Jim's repositories with citations pinned to the indexed commit, can take the visitor to a section of this site, can draft a message for the visitor to send, can write downloadable documents, can put a real calendar slot in front of the visitor to confirm, and answers a pasted job description as an evidence table with explicit gaps. `/assistant/` explains all of this to visitors.

### Local setup

1. Copy the root `.env.example` to `.env` without overwriting existing settings. Set `PUBLIC_API_URL=http://localhost:3001`.
2. In `server/`, run `npm install`, copy `.env.example` to `.env`, and set `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` and `DATABASE_URL`.
3. At the site root, run `npm install` and then `npm run dev` to start both services. Visit `http://localhost:4321`.

PostgreSQL 13+ with the `vector` extension available, managed or local. A disposable local one:

```sh
docker run -d --name portfolio-pg -p 55432:5432 \
  -e POSTGRES_USER=portfolio -e POSTGRES_PASSWORD=portfolio -e POSTGRES_DB=portfolio pgvector/pgvector:pg17
```

`server/src/schema.sql` is applied at boot and by the indexer, so there is no separate migration step yet.

### Code index

`server/src/repos.ts` decides which repositories the assistant may read: the names listed in `INCLUDED`, and nothing else. Adding a name there is the single step that lets the assistant talk about a repository; removing one prunes what was already indexed under it on the next indexing run. Nothing outside the list is ever fetched, indexed or quoted.

```sh
cd server && npm run index          # all allowed repositories
cd server && npm run index hyprfm   # one of them
```

Indexing clones the pinned branch tip, skips vendored, generated, binary, oversized and credential-shaped files, splits the rest into overlapping 60-line windows with detected symbols, embeds every window, and promotes the result in one transaction at the end. The new revision is written before the embedding starts and stays invisible while it fills, because every query filters on the live revision; a run that dies leaves it behind on purpose, so the next run reuses the vectors already paid for. Readers keep seeing the previous revision until that commit lands, a failed run changes nothing, and promoting a revision deletes the old one, so renamed and deleted files disappear. Re-run it after pushing code, and re-run it fully after changing `OPENROUTER_EMBEDDING_MODEL` or `OPENROUTER_EMBEDDING_DIMS`: an index built with other dimensions is ignored until rebuilt. A full run of the current repositories takes a couple of hours, almost all of it embedding requests, but a re-run skips repositories whose head commit has not moved and reuses the vector of every window whose text is unchanged, so the hourly timer costs nothing in practice.

Search scores are weighted by repository before ranking: repositories linked from the projects pages count for more, as do stars and a recent push. Weighting only reorders results. Nothing is hidden, and a search scoped to one repository ignores the weight entirely.

Check retrieval quality against the checked-in question set in `server/evals/code-questions.json`:

```sh
cd server && npm run eval:retrieval
```

The combined command labels frontend/API logs and stops both services on Ctrl+C or when either process exits. Use `npm run dev:site` or `npm run dev:api` at the root to run one service separately. Stop any previously started servers before using the combined command.

The frontend origin must match `SITE_ORIGIN` exactly, including port. Server environment validation rejects the example key/model placeholders. Never put provider credentials in `PUBLIC_*` variables.

- API health: `http://localhost:3001/health`
- Interactive Scalar documentation: `http://localhost:3001/docs`
- Exportable OpenAPI specification: `http://localhost:3001/openapi.json`

While answering, the model may call eight tools: `search_knowledge` (hybrid full-text and vector search over the index), `read_source` (a bounded window of one indexed file), `list_files`, `show_section` (take the visitor to a part of this site), `prepare_contact` (draft a message), `create_artifact` (write a downloadable document), `get_availability` (read real calendar slots), and `propose_booking` (offer one slot for confirmation). Each call is bounded, validated against the allowlist, and capped by `MAX_TOOL_STEPS`; the final step runs without tools so the model must answer. Tool results are wrapped as untrusted evidence, so text inside the source code cannot redirect the assistant. The stream reports each execution and the sources actually read, and both are stored with the answer.

`show_section` takes a target id from `src/data/site-map.ts`, the closed list of places the assistant may send a visitor. The model never supplies a URL or a selector: it names a target, and the browser looks the route and `data-anchor` up in its own copy of that table, so a poisoned route or selector in the stream is ignored. The browser navigates through Astro, waits for the anchor to appear, scrolls without taking focus, frames it briefly, and reports back to `POST /v1/actions/{id}` with `done`, `missing` or `failed`. Only the session that requested an action can acknowledge it, once. Actions never replay when a stored conversation is restored. Adding a target means adding a row to the table and a `data-anchor` attribute to the markup.

### Scheduling

Scheduling runs on Google Calendar directly, with no scheduling service in between. `get_availability` reads your real free/busy list and turns it into bookable slots here: your working hours, meeting length, buffer and notice period, computed in your own time zone and then shown to the visitor in theirs. The picker groups slots by day with a count per day and a compact time grid, and the model receives a per-day summary with a handful of example times rather than the whole list, which keeps a week of availability from costing a thousand prompt tokens.

There is no tool that books, mirroring contact. Picking a time calls `POST /v1/proposals`, which re-checks live availability and holds that slot for confirmation, so a visitor can book even when the model only listed times; `propose_booking` does the same from the model's side. Either way the visitor confirms through `POST /v1/bookings` with the slot and details they saw.

At confirmation the server claims the proposal atomically, re-reads free/busy, and refuses a slot taken in the meantime with 409 and the current times, which the panel shows immediately. Confirming the same proposal twice returns the first booking rather than making a second. If Google does not answer, or answers 5xx, the outcome is recorded as unknown and never retried automatically, because the event may already exist; the visitor is told to check their email first. Bookings are capped per day across the whole server, and unconfirmed proposals expire and are swept.

A confirmed booking becomes a Google Calendar event with the visitor as an invited attendee, so Google sends the invitation and the reminders. Set `GOOGLE_ADD_MEET=true` to attach a Meet link.

#### Setting it up

1. In Google Cloud, create a project, enable the Google Calendar API, and create an OAuth client of type **Desktop app**.
2. Put the client id and secret in `server/.env`.
3. Run `cd server && npm run google:auth`, approve in the browser, and paste the `code` parameter back. It prints the refresh token to store as `GOOGLE_REFRESH_TOKEN`.

The defaults are weekdays 09:00 to 18:00 `Asia/Dhaka`, 12 hours notice, a 10 minute buffer around existing events, half-hour slot starts, and a 14 day window. All of it is configurable, and the daylight-saving arithmetic is covered by tests in `src/slots.test.ts`. Without the three credentials the tools are refused, the endpoints answer 503, and the assistant never offers a call.

### Artifacts

`create_artifact` writes a Markdown brief, project comparison or Mermaid diagram, cites the source ranges it read and labels what it inferred. The document is stored privately in R2 under a key the server builds from its own ids, so a title can never shape the path. Documents over `ARTIFACT_MAX_BYTES` are refused, as is anything containing HTML, an inline event handler or a script-like URL. `GET /v1/artifacts/{id}` checks that the artifact belongs to the caller's session and only then returns a signed URL valid for `ARTIFACT_URL_TTL_SECONDS`; another session gets 404. Rows expire after `ARTIFACT_TTL_DAYS` and the hourly sweep deletes the objects with them, so nothing stored outlives its row.

Diagrams render through Mermaid with `securityLevel: 'strict'` and HTML labels off, and fall back to inert source if a diagram fails to parse, so a model-written diagram can only ever draw shapes and text. Each rendered diagram can be saved as SVG or PNG, rasterised in the browser at twice the size, alongside the Markdown download. Mermaid and its layout engines are a large lazy chunk fetched the first time a diagram appears, never on page load. Previews reuse the same sanitized Markdown renderer as answers.

Set `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` to switch this on, with a bucket-scoped token and the bucket kept private. Without all four the tool is refused and downloads answer 503.

### Code, images and attachments

Code blocks are highlighted by Shiki through `@streamdown/code`, loaded on demand with the Markdown renderer and shared by answers, citation snippets and the file viewer, so one theme covers all three.

The assistant can put one of the portfolio's own screenshots on screen with `show_image`. The list comes from `src/data/site-map.ts`, built from the project content, so the model names an id and can never point the page at an arbitrary URL.

A visitor can attach an image by button, paste or drag. The browser downscales it to 1400px on the long edge and re-encodes it as JPEG, which also strips camera and location metadata, then sends it as a data URL with that one question. The server validates the media type and the data URL shape before the model sees it. Attachments are never stored: the conversation keeps the question with a note that a picture came with it, so reloading later shows the text without the bytes. This needs a model that accepts images; the configured one does.

### Citations

A citation in an answer links to the cited lines on GitHub at the indexed commit. Any element on the site can open the panel with a question by carrying `data-assistant-ask="question"`, which is how the project sheets offer "Ask about this project".

### Contact

`prepare_contact` only shows the visitor an editable preview. There is deliberately no tool that sends, so a forged or hallucinated tool call cannot deliver anything: the only path to the email provider is `POST /v1/contact`, which the browser calls with the exact text the visitor approved. A draft is bound to its session, expires after `CONTACT_DRAFT_TTL_MINUTES`, and posting the same draft twice returns the first result instead of sending again. A provider failure keeps the draft and the text so the visitor can retry, and frees the reserved send. Sends are capped per address per hour and per day across the whole server, a honeypot field is accepted silently, and the reply address is the visitor's so answering the mail reaches them.

The site's own contact dialog posts to the same endpoint, so both paths share the validation, limits and delivery. Set `RESEND_API_KEY`, `CONTACT_FROM` (on a domain verified in Resend) and `CONTACT_TO` to switch delivery on; without all three the assistant says delivery is off and points at the contact page, the endpoint answers 503, and the dialog falls back to the visitor's mail client. A 202 means the provider accepted the message, not that it reached the inbox.

Every `/v1` route requires the configured site Origin. `POST /v1/sessions` issues a bearer token for one anonymous visitor; `POST /v1/chat` streams an answer. The browser sends recent turns as `history`; the server retains the newest `MAX_MESSAGES_PER_SESSION` and trims the oldest to fit the context budget. A finished answer is cached for `ANSWER_CACHE_TTL_HOURS` (default 24, 0 disables it) under a SHA-256 hash of the model, system prompt, indexed commits, visitor time zone, question and **full retained history**. Identical contexts from any visitor replay with `usage.cached` set, without a model call or daily-budget request. Matching only a suffix is unsafe: an answer may quote earlier private context. Failed or truncated answers and answers containing drafts, bookings, documents, slot lists or navigation are not cached. Reindexing or changing the prompt automatically changes the key. Scalar documents the contract; the API docs page has a different origin, so use the site or curl:

```sh
TOKEN=$(curl -s -X POST http://localhost:3001/v1/sessions \
  -H 'Origin: http://localhost:4321' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

curl -N http://localhost:3001/v1/chat \
  -H 'Origin: http://localhost:4321' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Tell me about HyprFM"}'
```

Each SSE frame has a `data:` field containing version-1 JSON: `delta` with `text`, `tool` with a real execution and its timing, `sources` with commit-pinned citations, `action` with a requested navigation, `draft` with a message preview, `artifact` with a generated document, `slots` with real availability, `proposal` with a call awaiting confirmation, `done` with `finishReason` (`stop` or `length`), or `error` with `message`. Unknown event types are ignored by the client, so the API can add more. Consume POST responses through `fetch` and a streaming reader rather than `EventSource`. A connection ending without a terminal event is an incomplete response. HTTP validation/rate errors return JSON before streaming starts.

### Current behavior and deployment

- Conversations live in the visitor's browser, in IndexedDB, and survive reloads without a network round trip. The server stores none of it; each question carries the finished exchanges before it, and a picture is sent only with its own question. History is the visitor's own transcript, so a forged turn can only steer that visitor's answer, and every tool that reaches the outside world still waits for their click. Clear chat deletes the local copy.
- The session token is a 32-byte random value held in `localStorage`; only its SHA-256 hash is stored. It scopes drafts, bookings, documents and navigation acknowledgements, not the conversation. An expired or unknown token is refused with 401, and the panel silently starts a new session and resends the question once. A session and what it owns are deleted `SESSION_TTL_DAYS` (default 7) after its last use, swept hourly and at boot. OpenRouter and its selected provider still receive message content under their own retention policies.
- Answers use Streamdown for streamed Markdown, code blocks, tables and links, with sanitized output and images disabled. The renderer is a lazy chunk preloaded when the panel opens, so no raw Markdown is shown while it loads. Message/code copying, stop/retry, scroll-to-latest, Enter-to-send and Shift+Enter newlines are supported. The assistant explicitly states it has no repository access or action tools yet.
- The panel shows the tool calls that ran with their timings, an expandable source list linking each cited range to GitHub at the indexed commit, a line per navigation with what actually happened, an editable message card that sends only when the visitor presses Send, a document card with an inline preview and a download button, and a slot picker with a confirmation card that books only when the visitor confirms. Snippets render as inert text.
- Chat UI: `src/components/chat/ChatPanel.tsx`; adapted registry primitives: `src/components/ui/` and `src/components/ai-elements/message.tsx`; styling: `src/styles/assistant.css`. Tailwind generates Streamdown utilities only, without a global preflight reset. Component attribution is in `THIRD_PARTY_NOTICES.md`.
- PostgreSQL atomically enforces per-address minute limits, hourly contact attempts and daily budgets across processes and restarts. Address keys are hashed. Rate-limit responses include `Retry-After`. Chat and transcription share a per-process concurrency cap, claimed before asynchronous budget checks. Set provider-side spending limits too: request counts are not dollar budgets.
- The API uses the socket peer unless it is explicitly listed in `TRUSTED_PROXY_IPS`. A trusted proxy must **overwrite** `X-Real-IP` with the actual client address; the API accepts only a single valid IP from that header. Without this setting, proxied visitors share the proxy's limit. Origin checks are not authentication.
- Origin, rate and session checks precede upload buffering. Normal JSON requests are limited to 200 KB; only transcription gets the configured audio allowance. Session tokens must match the issued format. API responses use `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`; private artifact URLs force attachment downloads.
- Draft and booking claims atomically enter an in-progress state. Unconfirmed provider outcomes and database failures after provider acceptance cannot be retried as fresh sends. Calendar confirmation serializes the live-availability check and booking across replicas using a PostgreSQL transaction advisory lock. If a process dies mid-send/confirmation, inspect provider records before resetting the in-progress row; it may already have succeeded.
- Identical read-only tool calls reuse results within a turn. Calendar lookups are reused within that turn, but a visitor's confirmation always checks live availability. Query embeddings share in-flight calls and a bounded 256-entry, ten-minute per-process cache; requests time out after ten seconds per attempt and permanent failures are not retried. Tool calls are limited to twelve per model step with bounded arguments.
- Deploy the repository together: `server/src/knowledge.ts` imports public content from `src/data/content.ts`. Start the API from `server/` with `npm start`; serve Astro's static output separately. Rebuild the site after changing `PUBLIC_API_URL`.
- Keep the API behind HTTPS in production. Disable proxy buffering for streaming responses and allow at least the configured request timeout. The default API bind address is loopback.
- `server/src/schema.sql` is applied idempotently at boot. Once columns start changing, move to a real migration tool. Back the database up and check a restore before launch.
- Run `npm run check` and the database-backed tests before release. Schema changes are applied at startup. Verify HTTPS, trusted proxy headers, streamed responses, provider spending limits and database backups in the deployed environment; local tests use mocked providers.

### Operations

`deploy/` holds what the VPS needs:

| File | Purpose |
| --- | --- |
| `portfolio-api.service` | systemd unit, 90 second stop timeout so streaming answers finish |
| `portfolio-index.service` + `.timer` | daily reindex; a failed run keeps the live index |
| `nginx.conf` | TLS, per-visitor rate limit, and the streaming settings |
| `backup.sh` | nightly `pg_dump` with an immediate restore check |

The proxy settings are the part that breaks quietly: with `proxy_buffering` on, answers arrive in one lump at the end instead of token by token. `proxy_read_timeout` must exceed `REQUEST_TIMEOUT_MS` so the API's own timeout fires first. Both measure silence, not total time: the API aborts when the provider sends nothing for `REQUEST_TIMEOUT_MS`, so a long answer keeps streaming up to a five-minute ceiling.

With nginx on the same machine, set `TRUSTED_PROXY_IPS=127.0.0.1,::1` and use `proxy_set_header X-Real-IP $remote_addr;`. If another proxy or CDN precedes nginx, configure nginx's trusted real-IP sources first; never pass through a caller-supplied header. Keep the API port private. Burst and daily limits are shared through PostgreSQL; concurrency and embedding caches are per process, so total model concurrency is the replica count multiplied by `MAX_CONCURRENT_REQUESTS`. Node bounds request uploads to 30 seconds and headers to 15 seconds; these limits do not cut off an active SSE response.

`backup.sh` refuses to call itself successful without restoring: set `VERIFY_URL` to a disposable database and it restores the dump and counts the tables. Verified locally against PostgreSQL 17: 28 KB dump, 10 tables restored. Neon also keeps its own point-in-time history, so this is a second line, not the only one.

### Data handling

- Stored on the server: an anonymous session identified by its token's SHA-256 hash; contact and booking details the visitor supplies; generated documents; hashed rate-limit counters; and cached answers keyed by the full model context. Answers can quote visitor text. Conversation histories remain in the browser rather than a server transcript table. No account or tracking cookie is required.
- Deleted: expired drafts and bookings, cached answers after `ANSWER_CACHE_TTL_HOURS`, and artifacts with their R2 objects when the artifact or owning session expires. Sessions expire seven days after last use; ownership rows are retained until object deletion succeeds so a storage outage cannot orphan private files. The sweep runs hourly and at boot. Clear chat erases the browser's copy of the conversation.
- Shared: message text goes to OpenRouter and whichever provider it routes to; a sent message goes to Resend; a booking goes to Cal.com. Nothing else leaves the server.
- Logged: error text only. No message bodies, no contact content, no credentials. Provider errors are reduced to a status before logging.

### Checks

At the site root: `npm run check` and `npm run build`.
In `server/`: `npm run check` and `npm test`. Tests mock OpenRouter and build a throwaway git repository locally, so they need no credentials, no network and cost nothing, but they do need a database with the `vector` extension and they `TRUNCATE` every table. They read `TEST_DATABASE_URL` only and refuse to fall back to `DATABASE_URL`:

```sh
TEST_DATABASE_URL=postgresql://portfolio:portfolio@localhost:55432/portfolio npm test
```

Two evaluations are separate because they cost real requests:

```sh
cd server && npm run eval:retrieval   # 12 code questions against the live index
cd server && npm run eval:answers     # 5 end-to-end checks against the real model
```

A third check runs against a real `npm run dev`, with no request mocking at all:

```sh
PLAYWRIGHT_BROWSERS_PATH=... node check-live.mjs
```

The mocked browser suites cannot catch CORS, so that one exists specifically to exercise the real preflight, stream, and calendar.

`eval:answers` covers grounding, admitting unavailable source, tool selection for contact and scheduling, and ignoring an instruction injected into a visitor message. It stubs out mail and storage, so it can never send or upload.

`npm run export:knowledge` regenerates `server/src/knowledge.json` from the site's content module. Run it after editing `src/data/content.ts`; `npm run dev` does it automatically. The API reads only that JSON, so it no longer imports frontend TypeScript.

## Social card

`public/assets/og.png` (1200x630) is the Open Graph image, hand-built to match the title sheet. It is a committed file, not generated at build time, so update it by hand if the name or tagline changes.

## Images

`public/assets/` holds the full-size screenshots plus a `-720.jpg` variant of each one that appears in a card or table cell. The small slots (home cards at 338px, parts-list thumbs at 150px) reference the 720px file through `thumb` in `content.ts`; the detail sheets, which render nearly full width, use the full-size file. Regenerate a variant by resizing the original to 720px wide at quality 80.

## Sitemap

`src/pages/sitemap.xml.ts` lists every route from `content.ts`. `public/robots.txt` points at it. Both assume the `site` in `astro.config.mjs`.
