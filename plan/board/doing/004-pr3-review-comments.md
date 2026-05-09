# Address PR #3 review comments

> **Status:** implementation-ready — readiness 100%
> **Last updated:** 2026-05-09
> **Resolved 2026-05-09:** service rename → `transcription-api` (item 5); TanStack DB live collections via custom sync adapter, risk accepted (item 6); `callback` → `result` everywhere (item 1c §B); dedupe = audit log + row-level CAS hybrid (item 1c §A); `consistent-type-assertions: never` repo-wide, no allowlist (item 3b).

Six review comments on [PR #3 (`feat: walking skeleton`)](https://github.com/realSergiy/totvibe-ocr/pull/3) need follow-up. Each one is tracked below with the context it touches, the proposed change, and the open questions to resolve before coding.

## 1. Drizzle schema — derive status from timestamps, drop DB caps, revisit `callbacks_seen`

> "status should be calculated from the corresponding `_at` date columns + constants to prevent impossible combinations. For both tables. — max pages and max size should be enforced on application level, not DB constraints. We will aim to allow arbitrary sized documents converted only limited by token budget and storage. — `callbacks_seen` by who? Names should be intuitive given no or minimum context. Avoid generic names like callback, processing, pipeline etc., prefer user-relevant names, fallback to domain-relevant. Let's review if we need this table in the first place and rename only if we do."

Files: `apps/web/drizzle/0000_early_smiling_tiger.sql`, `apps/web/src/durable-objects/schema.ts`, `apps/web/src/durable-objects/migrations.ts`, `apps/web/src/durable-objects/user-do.ts`, `apps/web/src/contracts.ts`.

### 1a. Status as a derived value

Today both tables persist `status` as a free-standing column with a CHECK enum (`ocr_jobs_status_enum`, `md_pages_status_enum`). The actual lifecycle is implicit in the timestamp columns (`created_at`, `started_at`, `completed_at`, `error`), so the explicit `status` column can drift from those — exactly the "impossible combination" the reviewer is flagging (e.g. `status='done'` with `completed_at IS NULL`).

Plan:

- Drop the persisted `status` columns and their CHECK constraints from both tables.
- Define a single `deriveStatus(row)` helper (per table) in `apps/web/src/durable-objects/schema.ts` (or a sibling `status.ts`) that returns the status from `(created_at, started_at, completed_at, error)` plus the `OcrJobStatus` / `MdPageStatus` enum constants already living in `contracts.ts`.
- Add `md_pages.created_at`, `md_pages.started_at`, `md_pages.completed_at` to make derivation work for the per-page table too. Today md_pages only has `error` + `markdown_key` to differentiate; that's not enough to round-trip a full lifecycle without ambiguity.
- Hydration / WS payloads: keep `status` on the wire (`OcrJobRow`, `MdPageRow`) because the SPA renders against it — compute it in `snapshot()` and the `*-upsert` builders rather than reading a column.
- Rename `ocr_jobs.completed_at` if the sweep logic ever needs to distinguish "completed successfully" from "errored at this time" — for now `error IS NULL` is the discriminator, so leaving `completed_at` is fine.

Open question — for the alarm sweep, the SQL currently does `WHERE status = 'awaiting_upload'`. After this change the sweep query becomes `WHERE started_at IS NULL AND error IS NULL AND created_at < ?`. Equivalent meaning, but means every status-filtered query has to be rewritten in terms of the underlying timestamps. Worth doing once and adding a comment block above the helper that lists the canonical predicate per status.

### 1b. Drop DB-level size and page-count limits

Remove these CHECK constraints from `ocr_jobs`:

- `ocr_jobs_size_bytes_max` (`size_bytes <= 52428800`)
- `ocr_jobs_total_pages_max` (`total_pages <= 100`)

Rationale per reviewer: arbitrary-sized documents are an explicit goal; only token-budget and storage cap us. Enforcement stays in the worker (`MAX_PDF_BYTES`, `MAX_PAGES` in `apps/web/src/constants.ts`) where it can be policy-tuned without a migration. The constants stay for now because the *current* worker policy is still 50 MB / 100 pages — but they're no longer a structural invariant of the schema.

### 1c. `callbacks_seen` — dedupe mechanism + "callback" rename

#### How it works today

Per main plan §7 #4, the pipeline POSTs once per page completion (and once per ocr-job-final state) to the public Worker route `/api/pipeline/callback` with payload:

```text
{ callback_id, ocr_job_id, page_number, status, markdown_key?, error? }
```

…plus an `x-callback-token` HMAC header (HMAC-SHA256 over the body, signed with a secret shared between Worker and the transcription service). The pipeline retries on transient HTTP failure with exponential backoff (main plan §8 step 3). If the network drops the response *after* the DO has already processed the row, the next retry would re-process the same page. Dedupe protects against that one race.

DO dedupe today (per `apps/web/src/durable-objects/user-do.ts`):

1. Verify the HMAC token; parse the payload.
2. `INSERT INTO callbacks_seen(callback_id, seen_at) VALUES (?, ?) ON CONFLICT DO NOTHING`.
3. If 0 rows inserted → replay; ack 200 and stop.
4. Otherwise → update `md_pages` for `(ocr_job_id, page_number)`; broadcast the delta.

The DO is single-writer (`USER_DO.idFromName('default')`), so this guards *only* against pipeline-side retries — not concurrent writers, not ordering, not anything else.

#### Two coupled choices: where dedupe lives + what to call it

The current name "callback" describes the wire mechanism, not the domain object. Both halves can change together — and naming the wire payload is what determines the table name (if we keep one).

##### A. Where dedupe lives

| Option | Shape | Tradeoff |
|---|---|---|
| **A1 — Side table, renamed** | Same shape as today: `(<id> text pk, received_at int)`. Worker route → side-table insert → row update. | Extra row + insert per delivery (incl. replays); preserves an audit trail of every delivery received including duplicates. Easy to reason about in isolation. |
| **A2 — Row-level CAS, no side table** | Per-page deliveries become `UPDATE md_pages SET … WHERE ocr_job_id=? AND page_number=? AND completed_at IS NULL AND error IS NULL`. `affected_rows = 0` ⇒ already terminal, this is a replay. Final ocr-job delivery: same CAS pattern on `ocr_jobs.completed_at`. | One fewer table; ties cleanly into §1a (status from timestamps) — the CAS predicate uses the same timestamp columns introduced there. No audit row for replays. Requires every terminal write path to use the CAS predicate consistently (one helper, one place to be careful). |

A1 keeps the "it shows up in the schema diagram" property — easy to audit. A2 collapses dedupe into the data model itself. Both depend on §1a landing first (so md_pages has the timestamp columns the CAS or the audit table refers to).

##### B. Replace "callback" everywhere it appears in v0.1

If we pick a domain term, the rename propagates to:

- Worker route: `POST /api/pipeline/callback` → `POST /api/transcription/<term>s`
- Wire payload field: `callback_id` → `<term>_id`
- Signed token: `callback_token` / `x-callback-token` → `<term>_token` / `x-<term>-token`
- DO method receiving the deliveries
- (If A1) the side table: `callbacks_seen` → `received_<term>s` or analogous

Candidates:

| Term | Route | Wire id | Side-table name (if A1) | Notes |
|---|---|---|---|---|
| `result` | `/api/transcription/results` | `result_id` | `received_results` | Clean domain noun; matches "transcription result" naturally. The page's `markdown_key` IS the result. |
| `delivery` | `/api/transcription/deliveries` | `delivery_id` | `received_deliveries` | Describes the wire act, not the content; usable if "result" feels too generic. |
| `completion` | `/api/transcription/completions` | `completion_id` | `received_completions` | Implies terminal state (done OR failed); slightly awkward for the final ocr-job-level POST that may fire even with failures inside. |

#### Decided 2026-05-09

- **Term: `result`.** Wire payload field `callback_id` → `result_id`. Signed token `callback_token` / `x-callback-token` → `result_token` / `x-result-token`. Public Worker route `POST /api/pipeline/callback` → `POST /api/transcription/results`. DO method receiving the deliveries also flips.
- **Mechanism: audit-log + row-level CAS hybrid (best of both).** The side table `received_results(result_id text pk, received_at int)` records every delivery received (including replays) for audit/debug, but does NOT gate the write. Dedupe is enforced by row-level CAS on the terminal-state predicate:
  - Per-page deliveries: `UPDATE md_pages SET … WHERE ocr_job_id=? AND page_number=? AND completed_at IS NULL AND error IS NULL`. `affected_rows = 0` ⇒ replay; the audit-log row still got written.
  - Final ocr-job delivery: same CAS pattern on `ocr_jobs.completed_at IS NULL AND error IS NULL`.
  - Both writes (audit insert + CAS update) happen in the same DO SQLite transaction.
- Tradeoff accepted: extra row + insert per delivery in exchange for a forensics trail (every delivery received, including replays, with timestamps) and a clean dedupe semantic that travels with the data.

Order with the rest of the plan: this lands as part of item #1 (schema rework — the CAS predicate uses the timestamp columns introduced there). The wire-payload rename merges with item #5 (service rename) so it's a single rename pass across the codebase.

## 2. eslint.config.ts — "do we need prettier plugin?"

> "do we need prettier plugin?"

Files: `eslint.config.ts`, `package.json`.

We don't currently load any prettier-related ESLint plugin. We *do* run `prettier --write .` separately (root `package.json` script), so style is enforced out-of-band of ESLint. The reviewer's question is therefore one of:

- (a) Should we add `eslint-config-prettier` to disable any stylistic rules from `@eslint/js`/`tseslint` that conflict with prettier? — Recommended industry practice; ~10 line addition; no rule churn.
- (b) Is one of the currently loaded plugins actually a prettier plugin in disguise? — No. The plugins in use are `@totvibe/eslint-plugin`, `eslint-plugin-perfectionist`, `eslint-plugin-prefer-arrow-functions`, `eslint-plugin-react`, `eslint-plugin-react-hooks`, `eslint-plugin-unicorn`, `typescript-eslint`. None overlap with prettier formatting beyond cosmetic rules already off-by-default in flat config.

**Action:** Reply on the PR with the inventory above, and add `eslint-config-prettier` (interpretation a). It's cheap insurance — confirms no rules conflict with prettier, and is the answer to "do we need a prettier plugin" that doesn't depend on us guessing the question.

## 3. eslint-plugin — drop `as` casts; add a rule that bans them

> "we should have a rule to not allow `as`. Instead imported rules should have `satisfies ESLint.Plugin['rules']`"

Files: `packages/eslint-plugin/src/index.ts`, `packages/eslint-plugin/src/rules/index.ts`, `packages/eslint-plugin/src/rules/no-as-casts.ts` (new), `packages/eslint-plugin/test/no-as-casts.test.ts` (new), `eslint.config.ts`.

### 3a. Fix the immediate offenders with `satisfies`

`packages/eslint-plugin/src/index.ts:10` — `rules: importedRules as unknown as ESLint.Plugin['rules']`. Replace by exporting the rules map with the right shape at the source (`packages/eslint-plugin/src/rules/index.ts`):

```ts
import { noInferrableReturnType } from './no-inferrable-return-type';
export const rules = {
  'no-inferrable-return-type': noInferrableReturnType,
} satisfies ESLint.Plugin['rules'];
```

Then `index.ts` can drop both casts:

```ts
const plugin = {
  meta: { name: '@totvibe/eslint-plugin', version: '0.0.0' },
  rules: importedRules,
} satisfies ESLint.Plugin;
```

Apply the same fix in `eslint.config.ts`:

- Line 28-30: `arrowFunctionsPlugin` uses `preferArrowFunctions.rules as ESLint.Plugin['rules']`. Wrap upstream rules with a typed adapter (or import them as `unknown` and validate with a schema if upstream types are wrong) — failing that, this single cast may be the lone exception worth keeping until the upstream package ships better types. Document the exception in a comment with a link to the upstream issue.

### 3b. Add a `@totvibe/no-type-assertions` rule

**Decided 2026-05-09: enable repo-wide with `assertionStyle: 'never'`, no allowlist, no custom rule.** `as const` is already excluded by the upstream rule; genuinely unavoidable casts get `// eslint-disable-next-line` per case. A custom `@totvibe/no-type-assertions` rule is reconsidered only if the post-3a audit turns up >5 unavoidable cast sites in genuinely-distinct categories.

`@typescript-eslint` ships `consistent-type-assertions` with `assertionStyle: 'never'`, which forbids both `x as T` and `<T>x`:

```ts
'@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
```

Add to `typescriptConfig` in `eslint.config.ts`.

Sequence: 3a (mechanical, no behavior change) → enable upstream rule → audit fallout → suppress per-line for the small unavoidable set.

## 4. eslint-plugin — more invalid examples for `no-inferrable-return-type`

> "can we have more invalid examples covering unique cases?"

Files: `packages/eslint-plugin/test/no-inferrable-return-type.test.ts`, possibly `packages/eslint-plugin/src/rules/no-inferrable-return-type.ts` if any of the new cases reveal a bug.

Today the test has three invalid cases (arrow, async function, class method). Add invalids that exercise the unique surfaces the rule should catch:

- **Object-literal method shorthand** — `const obj = { greet(): string { return 'hi'; } };` (covered by `Property[method=true]`?).
- **Object-literal arrow property** — `const obj = { greet: (): string => 'hi' };`.
- **Generator function** — `function* gen(): Generator<number> { yield 1; }`. Even if the rule short-circuits on generators, document it with a valid case; if it strips the type, that's the invalid shape to assert.
- **Function expression assigned to a variable** — `const greet = function(): string { return 'hi'; };`.
- **Named function declaration with non-trivial body** — `function compute(): number { const x = 1; return x; }` to confirm flow analysis isn't accidentally required.
- **Default parameter value influencing inference** — `const f = (x: number = 0): number => x;`.
- **Class constructor / accessor** — `class A { get x(): number { return 1; } }` and ensure constructors aren't flagged (constructors don't have return types syntactically, but a malformed test would).
- **Method on an interface vs. class** — interface methods declare return types syntactically (no body) and must remain valid. Add as a *valid* counterpart so the rule doesn't reach into ambient declarations.
- **Function in a `.tsx` file with JSX in body** — same shape, different parser path; protects against parser-options regressions.
- **Tuple / inferred object return** — `const f = (): readonly [number, string] => [1, 'a'] as const;` — confirms the rule strips the annotation when the literal already pins it.

Each new invalid should specify both `errors` and `output` so the autofixer is exercised. Where the rule's behavior is intentionally narrower than "any redundant return type" (e.g. type guards, asserts, declarations, recursive arrows — already in valid), add a comment in the test explaining why each invalid is unique.

## 5. Rename the `pipeline` service

> "'pipeline' service is too generic name. Think of a name better explaining what the service does."

**Decided 2026-05-09: `transcription-api`.** Matches existing domain vocabulary (`md_pages`, the `transcribing` lifecycle state); survives a model swap; the `-api` suffix accurately reflects HTTP-surface ownership.

Files: `services/pipeline-api/**` → `services/transcription-api/**`, `pyproject.toml` (workspace members), `services/transcription-api/pyproject.toml` (`[project].name`, `[project.scripts]`), `infra/compose*.yaml` (service name + image tag), `apps/web/wrangler*.jsonc` (env vars `PIPELINE_BASE` → `TRANSCRIPTION_BASE`), `apps/web/src/durable-objects/user-do.ts` (callback URL construction), `apps/web/src/server.ts` (the `/api/pipeline/callback` route — terminology rename pending §1c resolution), `justfile`, `README.md`, all docs in `plan/`.

What the service actually does: it accepts a PDF + presigned upload reference, runs GLM-OCR (or its mock) page-by-page on the GPU, and posts per-page Markdown back via a signed delivery POST. It's an OCR runner, not a generic pipeline.

The rename is mechanical — execute as the last step of this plan to avoid merge conflicts with the other items, and bundle it with the `callback` → `<term>` rename from §1c so it's a single pass. Concrete renames:

- Directory: `services/pipeline-api/` → `services/transcription-api/`.
- Python module: `pipeline.py` → `transcription.py` (and `pipeline_mock.py` → `transcription_mock.py`); `pipeline_id` column kept as-is (it names the *internal* id minted by the service for its own crash-recovery row, which is a distinct concept from the service's own name).
- Env var `PIPELINE_BASE` → `TRANSCRIPTION_BASE` (worker → service). `WORKER_INTERNAL_BASE` stays (it names the worker, not the renamed service).
- Public route `/api/pipeline/callback` → `/api/transcription/<term>` once §1c picks the term. HMAC-signed surface; for dev this is a one-shot, no deploy coordination needed (pre-v0.1).
- `compose.mock.yaml` service block; `justfile` recipe names; `README.md`; all docs in `plan/` (skip historical artifacts in `plan/board/done/`).
- `apps/web/src/contracts.ts` — anything referencing the wire payload field `callback_id` flips to `<term>_id`.

## 6. TanStack DB live collections — drop the manual hydrate + WS plumbing

> "The whole point of using TanStack DB was the live updates and mutations - so that we didn't have to manage with hydrations and sockets. And so that we didn't have to expose the API. Please change to live collections (<https://tanstack.com/db/latest/docs/overview#using-live-queries>)"

**Decided 2026-05-09: custom sync adapter over server functions, full rewrite, accept TanStack DB 0.x adapter-API churn risk.** Pre-v0.1 with zero deployment surface — if the adapter shape moves in a minor version, the rewrite is cheap. Pays the dividend immediately: no public `/api/me/*` routes, no manual hydrate, no manual reconnect.

Files: `apps/web/src/client/ocr-jobs-collection.ts` (rewrite), `apps/web/src/server.ts` (remove `/api/me/items`, `/api/me/ws`), `apps/web/src/durable-objects/user-do.ts` (replace WS broadcast with subscriber-stream registry; keep DO-internal subscription mechanism), `apps/web/src/server-fns/uploads.ts` (already a server fn — pattern to follow), and new server fns for ocr-job + per-page streams.

Today's flow (`ocr-jobs-collection.ts`):

- `fetch('/api/me/items')` for hydration.
- `WebSocket('/api/me/ws')` for live deltas.
- Manual exponential reconnect, manual `applySnapshot` / `applyDelta`, manual `Writer` plumbing.

That's the exact "manage hydrations and sockets" the reviewer flagged. Per the [TanStack DB live-queries docs](https://tanstack.com/db/latest/docs/overview#using-live-queries), the framework owns the wire protocol if we feed it via a sync adapter (e.g. `electricCollectionOptions`, `queryCollectionOptions`, or a custom adapter that wraps a server fn that returns a stream).

The decision is which adapter to use:

- **`@tanstack/db-collections` + `queryCollectionOptions`** — backs the collection by a TanStack Query that we re-fetch on intervals or invalidations. Loses real-time feel; gains zero infra.
- **Custom sync adapter over server fns + Cloudflare-native streaming** — server fn returns an `AsyncIterable` of deltas; collection consumes via the documented sync adapter shape. Keeps real-time, drops WS, drops the public `/api/me/*` routes.
- **Switch to Electric / a sync provider that has a published collection adapter.** — overkill at this stage; revisit if we outgrow DOs.

**Chosen shape (custom adapter over server fn streams):** the DO already serializes writes; expose two server fns (`streamOcrJobs`, `streamMdPages(ocrJobId)`) that each return an async iterable; the DO pushes by writing to a per-connection `ReadableStream` exposed via an RPC stub method, and the server fn forwards that stream. Reuses the existing DO broadcast machinery (already there for WS) but keeps the contract internal — the SPA only ever calls server fns. Hibernation-aware WS constraint goes away with the public WS route; revisit only if v1 per-user DOs need long idle subscriptions.

Coupling with #1 (status derivation): the upsert payloads currently include `status`, derived in `user-do.ts`. After #1 they're still derived; the wire shape can stay the same. Order: do #1 first, then #6, so the live-query rewrite isn't churning over the old `status` column shape.

Optimistic insert (separately tracked in `plan/board/done/002-post-skeleton.md`) should land *with* this work — `onInsert` is the documented hook for live collections, and the upload reserve flow (`server-fns/uploads.ts`) is the natural caller.

Risk knowingly accepted: TanStack DB sync adapters are still on a moving 0.6+ target. Pre-v0.1 + zero deployment + small surface = a forced rewrite if the adapter shape changes is cheap. Bias is "be brave, try it now while the cost is lowest".

## Suggested execution order

1. **#3a** — mechanical `as` → `satisfies` cleanup (no semantic change, smallest blast radius).
2. **#4** — extra invalid tests for `no-inferrable-return-type` (independent, fast feedback).
3. **#3b** — turn on `consistent-type-assertions: never`, fix fallout, decide on a custom rule.
4. **#1** — schema rework (status derivation, drop CHECK caps, dedupe disposition from #1c). Moves wire shapes too, so do it before the live-query rewrite.
5. **#6** — TanStack DB live collections; deletes worker `/api/me/*` routes.
6. **#5 + the `callback`→`<term>` rename from #1c** — single combined rename pass, last because it touches every file the previous steps may have touched.
7. **#2** — reply on the PR thread (drop-in `eslint-config-prettier`) — cheap, can ship at any point.

## Open questions to resolve before coding

*All resolved 2026-05-09. Decisions:*

- Service rename target: `transcription-api` (item 5).
- TanStack DB live collections via custom sync adapter; risk accepted (item 6).
- Wire/route/token term: `result` (item 1c §B).
- Dedupe mechanism: audit-log table `received_results` + row-level CAS hybrid (item 1c §A).
- `consistent-type-assertions: 'never'` repo-wide, no allowlist (item 3b).
