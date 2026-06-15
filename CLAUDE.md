# Claude Development Guidelines

## Project Overview

`@postalsys/email-ai-tools` is a Node.js library that adds AI/LLM features on top
of parsed email data. It talks to OpenAI-compatible HTTP APIs (chat completions,
text completions, embeddings, model listing) to summarize messages, score them
for risk, generate vector embeddings, and answer questions over stored email.

It is published to npm and consumed by other Postal Systems projects - most
notably EmailEngine (`../emailengine`), where it ships inside a standalone binary
built with `@yao-pkg/pkg`. See **Packaging Compatibility** below; it constrains
which dependencies this library may use.

## Project Structure

- `index.js` - Public entry point; re-exports the functions listed below
- `/lib` - Implementation modules (one feature per file)
- `/test` - Tests using the Node.js native test runner (`*.test.js`)
- `/test/helpers/mock-server.js` - Local mock of the OpenAI-compatible API used by tests
- `/examples` - Standalone usage examples (excluded from lint and CodeQL)

### Library Modules

- `lib/generate-summary.js` - `generateSummary()` plus `DEFAULT_SYSTEM_PROMPT` /
  `DEFAULT_USER_PROMPT`; produces a natural-language summary of a message.
- `lib/risk-analysis.js` - `riskAnalysis()`; flags suspicious/risky email content.
- `lib/generate-embeddings.js` - `generateEmbeddings()` / `getChunkEmbeddings()`;
  splits message text into chunks and returns vector embeddings.
- `lib/embeddings-query.js` - `embeddingsQuery()` / `questionQuery()`; answers
  questions over a set of emails using embeddings and chat completions.
- `lib/list-models.js` - `listModels()`; lists models exposed by the API endpoint.

## Technology Stack

- **Runtime**: Node.js (CI tests on 22 and 24). No build step - plain CommonJS.
- **Module system**: CommonJS (`'use strict';`, `require`/`module.exports`).
- **HTTP**: `undici` (`fetch` + `Agent`) for all outbound API calls.
- **Tokenizing**: `gpt3-tokenizer` for token-count budgeting.
- **Email/text helpers**: `@postalsys/email-text-tools`, `libmime`,
  `nodemailer/lib/addressparser`, `linkify-it`, `tlds`, `punycode.js`.

## Development Commands

```
npm test          # Run the test suite (node --test test/*.test.js)
npm run lint      # Lint with ESLint
npm run format    # Format code with Prettier
npm run update    # Refresh deps: remove node_modules + lockfile, ncu -u, npm install
```

## Testing

- Uses the Node.js native test runner with the native `assert` module.
- Tests live in `/test` and must be named `*.test.js` - the runner glob only
  matches that pattern, so helpers (e.g. `test/helpers/mock-server.js`) are never
  picked up as test files.
- Tests are hermetic: they run against the in-process mock server in
  `test/helpers/mock-server.js` rather than calling real OpenAI endpoints. Do not
  add tests that require live API credentials or network access.
- Run `npm test` before committing and make sure it passes.

## Packaging Compatibility (important)

EmailEngine bundles this library into a single executable with `@yao-pkg/pkg`.
`pkg` snapshots the CommonJS `require` graph at build time, so **every dependency
must be CommonJS-compatible**. Do not introduce pure-ESM-only packages or
ESM-only versions of existing packages.

- New ESM-only majors are blocked in `.ncurc.js` via the `reject` list (e.g.
  `nanoid` moved to ESM and is pinned).
- `undici` is pinned to the 7.x line; 8.x requires Node >= 22.19.
- When `npm run update` proposes an upgrade, confirm the new version still
  publishes a CommonJS build and still loads under `require()` before accepting
  it. If a package goes ESM-only, add it to the `reject` list in `.ncurc.js` with
  a one-line comment explaining why.

## Dependency Management

- Use `npm run update` to bump dependencies (it runs `ncu -u` then a clean
  install). Respect the `reject` list in `.ncurc.js`.
- After updating, run `npm test`, `npm run lint`, and
  `npx prettier --check "**/*.{js,json,md}"` to confirm nothing broke.
- Keep `package.json` versions exact (no `^`/`~` ranges) to match the existing
  convention and keep `pkg` builds reproducible.

## Versioning & Releases

- Releases are automated with **release-please** (`.github/workflows/release.yaml`).
  Merging Conventional Commit messages to `master` opens/updates a release PR;
  merging that PR tags the version, updates `CHANGELOG.md`, and publishes to npm
  with provenance.
- Commit prefixes drive the version bump: `fix:` -> patch, `feat:` -> minor,
  `feat!:` / `BREAKING CHANGE:` -> major.

## Code Style Rules

- CommonJS only - every module starts with `'use strict';` and uses
  `require`/`module.exports`. No `import`/`export`.
- Never use emojis in code or documentation; printable ASCII characters only.
- Use a single hyphen-minus (`-`) as a dash in user-facing strings and docs.
  Never use double hyphens (`--`), em dashes, or en dashes.
- Formatting is owned by Prettier and linting by ESLint - run both before
  committing; do not hand-format against them.
- **Git commit messages: do not list Claude (or any AI) as a co-author or
  contributor.** Write commit messages in the project's own voice.
- Use Conventional Commit prefixes so release-please works (`fix:`, `feat:`,
  `chore:`, `docs:`, `test:`, `ci:`, `refactor:`).
- For commits that do not change runtime behavior (docs, comments, CI/workflow
  tweaks, formatting), append `[skip ci]` to the commit message to avoid
  triggering the GitHub Actions workflows. Exception: do not add `[skip ci]` to
  commits using a `fix:` or `feat:` prefix - those must run so the release action
  is triggered.

## Workflow After Making Changes

1. Run `npm run format` and `npm run lint`.
2. Run `npm test` and confirm it passes.
3. Review changed code for reuse, quality, and efficiency (`/simplify`), and run
   `/security-review` for anything touching parsing, prompts, or outbound HTTP.
4. After pushing, check the GitHub Actions runs (e.g. `gh run list --branch master`)
   and report their status, including the CodeQL ("code quality") results. If a
   run fails for an unrelated infrastructure reason (checkout reporting "account
   suspended", HTTP 403, other auth errors), check https://www.githubstatus.com/
   for an active GitHub incident before assuming the code is at fault.
