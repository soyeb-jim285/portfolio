# Portfolio assistant implementation plan

Status: Phase 1 complete except the follow-ups named below. Implemented: Hono/OpenRouter streaming, Scalar `/docs`, `/openapi.json`, environment examples, request limits, and an Astro chat panel whose conversation survives navigation and reloads. Backend tests use a mocked provider. A live OpenRouter response has also been verified with local credentials. Root `npm run dev` starts both services; combined startup and shutdown have been checked.

PostgreSQL-backed anonymous sessions and messages are in place: server-issued bearer tokens stored as SHA-256 hashes, session-scoped history owned by the server, sliding 7-day expiry with an hourly sweep, a per-session message cap, immediate deletion on clear, and a daily request budget shared through the database. The frontend uses a slim, user-resizable full-height shadcn-based side panel with AI Elements messages and sanitized streamed Markdown, and restores its conversation after a reload.

Phase 2 is implemented: an index of every public repository with pinned commits, secret/vendor/binary filtering, overlapping line chunks with detected symbols, OpenRouter embeddings plus PostgreSQL full-text search fused by reciprocal rank, atomic revision promotion, `search_knowledge` / `read_source` / `list_files` tools inside a bounded tool loop, real tool-activity and citation events in the stream and UI, and a checked-in retrieval evaluation that passes 12 of 12 cases.

Phase 3 is implemented: a closed target registry shared by the API and the browser (`src/data/site-map.ts`) with `data-anchor` attributes in the markup, a `show_section` tool, `action` stream events recorded in `ui_actions`, browser execution that navigates through Astro, waits for the anchor, scrolls without stealing focus and frames the section, acknowledgements at `POST /v1/actions/{id}` bound to the requesting session and accepted once, no replay of stored actions, and multi-target tours. The prompt forbids claiming a move that was not requested, which live testing confirmed.

Phase 4 is implemented: a single `POST /v1/contact` delivery path shared by the assistant and the site's own dialog, Resend over plain fetch with a fixed recipient and the visitor's address as Reply-To, a `prepare_contact` tool that can only draft, an editable preview card that sends nothing until the visitor presses Send, session-bound expiring drafts, idempotent delivery, failures that keep the text and free the reserved send, per-address hourly and server-wide daily send caps, and a honeypot. There is no send tool, so a forged tool call cannot deliver anything. Verified against a mocked provider; a live send still needs `RESEND_API_KEY`, a verified `CONTACT_FROM` domain and `CONTACT_TO`.

Phase 5 is implemented: a `create_artifact` tool for Markdown briefs, comparisons and Mermaid diagrams with cited evidence and labelled inference, HTML/script and size rejection, private R2 uploads under server-generated keys through signed S3 requests, session-checked downloads that return a short-lived signed URL, expiry metadata and an hourly sweep that deletes objects with their rows, an inline preview that reuses the sanitized Markdown renderer, and Mermaid rendered in strict mode with HTML labels off, lazily loaded and falling back to inert source. Verified against a mocked bucket, including a hostile diagram that renders without executing; a live upload still needs the four `R2_*` values.

Phase 6 is implemented against the Google Calendar API directly, with no scheduling service in between: free/busy is read and turned into slots here, using configured working hours, buffer and notice, with daylight-saving arithmetic covered by tests.

Phase 7 is implemented except deployment itself: job-description answering as an evidence table with explicit gaps, measured latency and provider-reported token usage in the trace, a public `/assistant/` sheet explaining the architecture, tools, data handling and limits, the build-time knowledge export, deployment units and an nginx configuration with streaming and per-visitor limits, a daily reindex timer, a backup script with a restore check verified locally, documented retention and provider sharing, a log audit confirming no message bodies or credentials are written, and a five-case answer evaluation that passes against the real model.

Remaining: deploying to the VPS and verifying it there, and a shared limiter if more than one API replica is ever run.

## Goal

Make the assistant a prominent portfolio feature: answer technical questions using actual project code, show its evidence and tool activity, guide visitors around the site, and help them contact Jim, book a call, or download a useful technical artifact.

## Agreed stack

- Existing Astro static frontend.
- Separately deployed Hono API on the VPS, running on Node.js.
- OpenRouter for tool-capable streamed chat and an explicitly selected embedding model.
- PostgreSQL with pgvector and full-text search for retrieval and application state.
- Cloudflare R2 for downloadable artifacts and optional repository snapshots.
- Resend for contact delivery.
- Zod-backed OpenAPI schemas and Scalar interactive documentation.
- Scheduling provider to be selected when booking is implemented; Cal.com is the default candidate.

Keep the API in `server/` with its own package and deployment configuration. Do not migrate the Astro site or introduce a monorepo framework. Use one scheduled indexing command rather than a separate queue service initially.

## Existing integration points

- `src/data/content.ts`: public portfolio facts, projects, and repository links.
- `src/data/cv.json`: factual provenance.
- `src/layouts/SchematicLayout.astro`: shared shell and Astro client-side navigation.
- `src/components/ContactDialog.astro`: existing contact dialog.
- `src/scripts/contact.ts`: form submission and `[data-contact]` openers.
- `.env.example`: currently exposes only `PUBLIC_FORM_ENDPOINT`.

Export an explicit public knowledge document from the portfolio data at build/index time. Review exported fields; do not blindly publish the entire CV source file. The frontend receives only public API URLs, never service credentials.

## Phase 1 — Working streamed assistant

Build the smallest complete frontend-to-model flow before repository indexing.

### Deliverables

- Hono application with validated configuration, health endpoint, `/openapi.json`, and `/docs`.
- `POST /v1/chat` with validated input and a documented streamed event contract.
- OpenRouter integration with a configured model, request timeout, output limit, cancellation, and actionable error responses.
- Public portfolio knowledge supplied as context, with instructions to distinguish known facts from unavailable source-code evidence.
- Server-issued anonymous sessions; bind conversation access to the session rather than accepting an arbitrary conversation ID as authorization.
- PostgreSQL migrations for sessions and messages; specify expiry and deletion behavior.
- Prominent assistant entry point, streamed responses, starter prompts, stop control, retry, and error state.
- Chat state preserved through Astro navigation, without duplicate event handlers or losing an active stream.
- Keyboard access, focus handling, mobile layout, reduced-motion support, and safe message rendering matching the existing schematic design.
- Origin restrictions, session/IP request limits, concurrency limits, and per-request token/cost bounds. CORS is not authentication or an abuse control.

### Stream contract

Use a POST request with a streamed response consumed through `fetch`. Define a versioned discriminated event union for text deltas, source references, tool status, UI actions, completion, and errors. Introduce event producers as their features are implemented. Document event payloads and error handling in OpenAPI; document how to consume the stream in the README.

### Acceptance

- A visitor can ask about HyprFM and receive a streamed answer grounded in portfolio facts.
- Source-code questions are not presented as verified until repository retrieval exists.
- Stop cancels upstream work; interrupted or failed responses are clearly marked.
- Navigation retains the chat; another session cannot read its messages.
- Runtime route validation and generated OpenAPI agree.

## Phase 2 — Code retrieval and source evidence

### Deliverables

- Every public repository of the account, discovered at index time and pinned to a commit.
- Indexing command that retrieves a pinned commit and excludes secrets, binaries, generated/vendor files, and oversized content.
- Source chunks containing repository, commit SHA, path, line range, content hash, and symbol metadata where practical.
- Embeddings plus PostgreSQL full-text search; combine ranked results and read surrounding source for context.
- Weight fused scores by repository: the ones linked from the projects pages, star count, and recency of the last push. Weighting reorders results, it never hides a repository, and scoping a search to one repository ignores it.
- Record embedding model/version and dimensions. Reindex when the embedding model changes.
- Publish new index revisions atomically so searches and source reads use consistent snapshots; remove stale/deleted content when promoting a revision.
- `search_knowledge` and `read_source` tools, with bounded result sizes and tool-loop limits.
- Expandable source snippets and GitHub citations pinned to the indexed commit.
- Tool activity based on real execution events, with sanitized arguments and timing.
- Retrieval treats source text as untrusted evidence, not executable instructions.

### Acceptance

- A small checked-in evaluation set pairs real code questions with expected files or symbols.
- Answers link to the exact revision and line ranges read by the tool.
- Unknown answers acknowledge missing evidence; snippets cannot invent paths or citations.
- Updates and deletions are reflected after a successful reindex.
- Fuego/Apa answers use approved public descriptions unless publishable source is explicitly supplied.

## Phase 3 — Website actions and guided tours

### Deliverables

- A fixed registry of allowed routes and named section targets.
- `show_section` tool for navigation, scrolling, and highlighting.
- Browser execution acknowledgements tied to action IDs, including missing-target and navigation failures.
- Wait for Astro page readiness before highlighting; keep chat usable throughout.
- Tours composed from existing knowledge and actions, tailored to visitor interests.

### Acceptance

- “Show me your agent engineering work” navigates to and highlights relevant public content.
- “How can I contact Jim?” highlights or opens the existing contact entry point.
- Model output cannot execute arbitrary scripts, choose arbitrary selectors, or navigate to unapproved URLs.
- Replayed actions do not execute twice; actions respect focus and reduced-motion preferences.

## Phase 4 — Contact through Resend

### Deliverables

- Hono contact endpoint compatible with the existing form payload.
- Resend integration using a verified sender domain, fixed recipient inbox, and visitor email as Reply-To.
- `prepare_contact` tool that drafts a message and displays an editable preview.
- Explicit visitor confirmation of the exact draft before `send_contact` can execute; enforce this server-side, not only in the prompt.
- Expiring, session-bound action records and idempotent delivery handling. Editing a confirmed draft requires a new confirmation.
- Clear pending, provider-accepted, and failed states; preserve drafts on failure. Provider acceptance is not a guarantee of inbox delivery.
- Server-side validation and send-specific rate limits for both direct form and chat paths.

### Acceptance

- Both the existing form and assistant deliver through the same backend flow.
- The visitor reviews recipients and message content before sending.
- A retry cannot trigger duplicate delivery; a forged model tool call cannot bypass confirmation.
- Optional conversation summaries are included only when shown in the approved draft.

## Phase 5 — Artifacts and R2

### Deliverables

- `create_artifact` tool for Markdown technical briefs, project comparisons, and Mermaid architecture diagrams.
- Evidence links included in generated artifacts; inferred architectural relationships are labeled.
- Safe diagram rendering with HTML/script execution disabled and size limits.
- Private R2 uploads with server-generated object keys, session-authorized downloads, and short-lived signed URLs.
- Artifact size limits, expiry metadata, and a cleanup/lifecycle policy.

### Acceptance

- A visitor can generate, preview, and download a source-backed project brief.
- Another anonymous session cannot request its download link.
- Unsafe diagram content cannot execute code in the portfolio origin.

## Phase 6 — Scheduling

### Deliverables

- Integrate the chosen provider's availability and booking APIs.
- `get_availability` and `book_call` tools with explicit timezone display.
- Session-bound confirmation of the slot and attendee details.
- Revalidate availability and handle conflicts, retries, and ambiguous provider timeouts without duplicate bookings.

### Acceptance

- Only real available slots are offered; no invented availability.
- Visitor sees the timezone, attendee details, and appointment before confirming.
- Conflict and failure states offer a clear recovery path.

## Phase 7 — Showcase and launch checks

- Job-description matching with evidence links and explicit gaps, using the existing retrieval tools.
- Inspectable source and tool trace, retrieval/response latency, and provider-reported usage where available; no hidden chain-of-thought.
- A public explanation of the assistant's architecture and limitations.
- End-to-end demo: technical question → code citations → website navigation → artifact → confirmed contact.
- HTTPS deployment, reverse-proxy streaming without buffering, upstream cancellation, and graceful restart behavior.
- Database backups with a restore check; scheduled indexing and artifact cleanup.
- Document data retention, clear-chat behavior, and which providers receive chat/contact data. Keep contact content and credentials out of operational logs.
- Small repeatable evaluations for factual grounding, retrieval relevance, tool selection, and adversarial source text.
- Frontend `npm run check` and `npm run build`, backend type checks, and focused integration tests for streaming, session isolation, confirmation, and idempotency.

## Configuration by phase

| Phase | Needed |
| --- | --- |
| 1 | OpenRouter key and chat model; PostgreSQL URL; permitted site origin; public API URL; server-only session secret |
| 2 | Approved repository list; embedding model and dimensions; GitHub token only if required for access or rate limits |
| 4 | Resend key; verified sender; fixed recipient inbox |
| 5 | R2 endpoint/account, bucket, and bucket-scoped credentials |
| 6 | Scheduling provider credentials and event type |

Configure secrets locally or on the VPS, not in chat or committed files. Exact environment variable names will be documented in `.env.example` files during implementation.

## First implementation task

Implement Phase 1 and demonstrate a real streamed response in the existing Astro site. Start with the Hono route and stream contract, connect the chat panel, and verify cancellation, errors, session isolation, and navigation persistence before proceeding to repository indexing.

## Beyond the plan

Four showcase features were added after Phase 7, all built on the existing index:

- An in-panel code browser: repository cards, a filterable file list and a file viewer at the indexed commit, reached from any citation or from a project sheet.
- A module dependency graph per repository, drawn from imports and includes parsed at index time, with ambiguous names dropped rather than guessed.
- A repository overview showing every indexed repository with its live facts.
- Scoped entry points, so any element on the site can open the assistant with a question or a repository already chosen.
- Shiki syntax highlighting across answers, citations and the file viewer.
- Images in both directions: `show_image` displays one of the portfolio's own screenshots from a closed list, and a visitor can attach an image that is downscaled and re-encoded in the browser, passed to the model for that turn, and never stored.
