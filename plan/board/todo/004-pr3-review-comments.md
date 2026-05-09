# Address PR #3 review comments

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

### 1c. Revisit `callbacks_seen`

Currently `callbacks_seen(callback_id, seen_at)` is the dedupe table for pipeline → worker callbacks. Two questions:

1. **Is the table needed?** It de-dupes retried callbacks from the pipeline. The pipeline currently uses fire-and-forget HTTP, so retries would only happen if we add them. The DO is single-writer (idFromName('default')) so naïve "set-if-absent" semantics could be expressed as `INSERT … ON CONFLICT DO NOTHING` against a key the callback already owns (e.g. `(ocr_job_id, page_number, status_at)`), folding dedupe into the page upsert. **Verdict:** Yes, keep dedupe — but consider whether it belongs as a side table or as a uniqueness constraint on the per-page row's terminal write. Pick this up while doing 1a — once md_pages has timestamps the dedupe key collapses naturally.
2. **If kept, rename.** `callbacks_seen` describes the mechanism. Better candidates: `pipeline_acks` (still mechanism), `processed_results` (domain-y — "we already processed this transcription result"), or `transcription_receipts`. Decide the table's purpose first, then name it.

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

`@typescript-eslint` already ships `consistent-type-assertions` with `assertionStyle: 'never'`, which forbids both `x as T` and `<T>x`. That's the existing answer for "no `as`" — enable it before writing a custom rule:

```ts
'@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
```

Add to `typescriptConfig` in `eslint.config.ts`. Allow specific escape hatches via either:

- `// eslint-disable-next-line` for genuinely unavoidable casts (errno-style narrowing, JSON.parse boundaries), or
- A custom rule allowing `as const` only — which `consistent-type-assertions` already excludes.

If after enabling the upstream rule we still need finer control, *then* author `@totvibe/no-type-assertions` with allowlist semantics (`{ allow: ['as const', /^as Json$/] }`). Don't write a custom rule speculatively.

Sequence: 3a (mechanical, no behavior change) → enable upstream rule (3b first half) → audit fallout → decide whether a custom rule is still needed.

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

Files: `services/pipeline-api/**` → `services/<new-name>/**`, `pyproject.toml` (workspace members), `services/pipeline-api/pyproject.toml` (`[project].name`, `[project.scripts]`), `infra/compose*.yaml` (service name + image tag), `apps/web/wrangler*.jsonc` (env vars `PIPELINE_BASE` etc.), `apps/web/src/durable-objects/user-do.ts` (callback URL construction), `apps/web/src/server.ts` (the `/api/pipeline/callback` route — see below), `justfile`, `README.md`, all docs in `plan/`.

What the service actually does: it accepts a PDF + presigned upload reference, runs GLM-OCR (or its mock) page-by-page on the GPU, and posts per-page Markdown back via a signed callback. It's an OCR runner, not a generic pipeline.

Candidate names (decide before mass-rename):

- `ocr-runner` — accurate, narrow.
- `transcription-api` — domain language ("transcription" already shows up in `md_pages.status='transcribing'`); reads as "the API that produces transcriptions".
- `ocr-api` — short, but undersells that it owns the GPU lifecycle.
- `glmocr-runner` — names the model; brittle if we swap models.

Recommendation: `transcription-api`. Matches existing domain vocabulary (`md_pages`, `transcribing`) and survives a model swap.

Once chosen, the rename is mechanical. Do it as the last step of this plan to avoid merge conflicts with the other items. Consider also renaming:

- env var `PIPELINE_BASE` → `TRANSCRIPTION_BASE` (worker → service).
- env var `WORKER_INTERNAL_BASE` stays (it's the worker, not the renamed service).
- `/api/pipeline/callback` Hono route → `/api/transcription/callback`. This is a public-ish surface (signed by HMAC), so coordinate with whatever's deployed before flipping. For dev this is a one-shot.
- `compose.mock.yaml` service block.
- `plan/board/done/002-post-skeleton.md` references — leave the historical artifact, just don't propagate the old name in new docs.

## 6. TanStack DB live collections — drop the manual hydrate + WS plumbing

> "The whole point of using TanStack DB was the live updates and mutations - so that we didn't have to manage with hydrations and sockets. And so that we didn't have to expose the API. Please change to live collections (<https://tanstack.com/db/latest/docs/overview#using-live-queries>)"

Files: `apps/web/src/client/ocr-jobs-collection.ts` (rewrite), `apps/web/src/server.ts` (remove `/api/me/items`, `/api/me/ws`), `apps/web/src/durable-objects/user-do.ts` (remove WS broadcast + items endpoints), `apps/web/src/server-fns/uploads.ts` (already a server fn — pattern to follow), and possibly new server fns for ocr-job listing / per-page listing.

Today's flow (`ocr-jobs-collection.ts`):

- `fetch('/api/me/items')` for hydration.
- `WebSocket('/api/me/ws')` for live deltas.
- Manual exponential reconnect, manual `applySnapshot` / `applyDelta`, manual `Writer` plumbing.

That's the exact "manage hydrations and sockets" the reviewer flagged. Per the [TanStack DB live-queries docs](https://tanstack.com/db/latest/docs/overview#using-live-queries), the framework owns the wire protocol if we feed it via a sync adapter (e.g. `electricCollectionOptions`, `queryCollectionOptions`, or a custom adapter that wraps a server fn that returns a stream).

The decision is which adapter to use:

- **`@tanstack/db-collections` + `queryCollectionOptions`** — backs the collection by a TanStack Query that we re-fetch on intervals or invalidations. Loses real-time feel; gains zero infra.
- **Custom sync adapter over server fns + Cloudflare-native streaming** — server fn returns an `AsyncIterable` of deltas; collection consumes via the documented sync adapter shape. Keeps real-time, drops WS, drops the public `/api/me/*` routes.
- **Switch to Electric / a sync provider that has a published collection adapter.** — overkill at this stage; revisit if we outgrow DOs.

Recommendation: middle option. The DO already serializes writes; expose two server fns (`streamOcrJobs`, `streamMdPages`) that each return an async iterable; have the DO push by writing to a per-connection `ReadableStream` and have the server fn forward that. Reuses the existing DO broadcast machinery (already there for WS) but keeps the contract internal — the SPA only ever calls server fns.

There is a coupling with #1 (status derivation): the upsert payloads currently include `status`, derived in `user-do.ts`. After #1 they're still derived; the wire shape can stay the same. Order: do #1 first, then #6, so the live-query rewrite isn't churning over the old `status` column shape.

Optimistic insert (separately tracked in `plan/board/done/002-post-skeleton.md`) should land *with* this work — `onInsert` is the documented hook for live collections, and the upload reserve flow (`server-fns/uploads.ts`) is the natural caller.

Open question: TanStack DB sync adapters are still on a moving target (0.6+ shape). Confirm the public adapter API is stable enough to depend on before swinging the rewrite.

## Suggested execution order

1. **#3a** — mechanical `as` → `satisfies` cleanup (no semantic change, smallest blast radius).
2. **#4** — extra invalid tests for `no-inferrable-return-type` (independent, fast feedback).
3. **#3b** — turn on `consistent-type-assertions: never`, fix fallout, decide on a custom rule.
4. **#1** — schema rework (status derivation, drop CHECK caps, decide on `callbacks_seen`). This moves wire shapes too, so do it before the live-query rewrite.
5. **#6** — TanStack DB live collections; deletes worker `/api/me/*` routes.
6. **#5** — rename `pipeline` → chosen name. Last because it touches every file the previous steps may have touched.
7. **#2** — reply on the PR thread (drop-in `eslint-config-prettier` if we go that way) — cheap, can ship at any point.

## Open questions to resolve before coding

- Final name for `services/pipeline-api/` (item 5).
- Whether to keep `callbacks_seen` as a side table or fold dedupe into the per-page write (item 1c).
- Whether `consistent-type-assertions: 'never'` is acceptable repo-wide, or we need an allowlist (item 3b).
- Whether the TanStack DB sync-adapter API is stable enough to commit to today (item 6).
