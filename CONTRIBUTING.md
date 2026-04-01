# Contributing to gridlook

Thanks for contributing to `gridlook`.

This project is a Vue 3 + TypeScript + Vite application for exploring Earth
system model output on native grids in the browser. The notes below are meant
to keep contributions aligned with the current tooling and release workflow.

## Development Setup

### Prerequisites

- Node.js `>=18` as defined in [`package.json`](package.json)
- `npm`

CI currently runs on newer Node versions as well, so using a recent LTS release
locally is a good default.

### Install dependencies

```sh
npm install
```

### Start the development server

```sh
npm run dev
```

The app is served at `http://localhost:3000`.

## Local Checks

Run these before opening a pull request:

```sh
npm run lint
npm run typecheck
npm run build
```

There is currently no dedicated test suite in the repository. The main quality
gate today is:

- ESLint
- TypeScript type checking
- A production build

Git hooks are installed through Husky on `npm install`:

- `pre-commit` runs `lint-staged` and `npm run typecheck`
- `lint-staged` runs ESLint with `--fix` and Prettier on staged JS, TS, and Vue
  files, and Prettier on staged JSON and Markdown files
- `commit-msg` runs Commitlint to verify the commit message format

In practice, Husky checks commit messages and runs linting, automatic fixes
where possible, and type checking during the commit flow. If a hook fails, fix
the remaining issue locally before retrying the commit.

## Workflow

1. Create a focused branch from `main`.
2. Keep changes scoped to one concern when possible.
3. Run the local checks above.
4. Open a pull request with a clear description of the change.

For UI or rendering changes, include screenshots or a short screen recording if
the visual result is not obvious from the diff.

## Commit Messages

This repository follows the
[Conventional Commit Guidelines](https://www.conventionalcommits.org/en/v1.0.0/)
and validates commit messages with Commitlint.

Use this format:

```text
type(scope): short description
```

Scope is optional but recommended. A commit without a scope is also valid:

```text
type: short description
```

Allowed commit types:

- `feat` for user-facing features
- `fix` for user-facing bug fixes
- `refactor`
- `test`
- `chore`
- `style`
- `docs`

Allowed scopes:

- `ui`
- `lib`
- `config`
- `deps`
- `docs`
- `assets`

Examples:

```text
feat(ui): add variable search to selector
fix(lib): handle reduced gaussian longitude wrapping
docs(docs): clarify cloud dataset requirements
```

The `main` branch is wired to Release Please, so commit history is part of the
release process. Use descriptive commit messages and avoid manually editing
[`CHANGELOG.md`](CHANGELOG.md) unless the change
explicitly requires it. In the current release flow, only `feat` and `fix`
commits result in changelog entries, so choose those types when the change
should appear in release notes. As a rule, reserve `feat` and `fix` for
user-facing changes; use `refactor`, `chore`, or `docs` for internal work
unless the implementation change is large enough that it meaningfully affects
the release narrative.

## Project Structure

Key directories:

- [`src/ui`](src/ui) for Vue UI, overlays, and grid presentation components
- [`src/lib`](src/lib) for rendering, projection, layer, and data-access logic
- [`src/store`](src/store) for shared state and URL/presenter synchronization
- [`src/utils`](src/utils) for general helpers
- [`public/static`](public/static) for static datasets, geojson, and colormap
  assets
- [`docs`](docs) for project documentation and presentation material
- [`scripts`](scripts) for maintenance scripts

ESLint boundary rules enforce the high-level dependency flow between these
areas. If you introduce a new import path or module location, check
[`eslint.config.js`](eslint.config.js) and keep the layering consistent.

In particular, keep [`src/lib`](src/lib) as self-contained as
possible. Core rendering and data logic should have little to no dependencies
on code outside `src/lib` other than shared utilities or assets that already
fit the existing boundary rules.

## Style Notes

- Prefer TypeScript for logic changes.
- Vue components must use `<script setup lang="ts">`.
- Use the `@` alias for imports rooted at `src/` (e.g. `import Foo from "@/lib/Foo"`).
- Keep imports ordered; ESLint will flag issues.
- Prettier is the formatting baseline for JS, TS, Vue, JSON, and Markdown.
- Favor small, targeted changes over broad refactors unless the refactor is the
  actual goal of the PR.

## Assets and Data-Specific Changes

If you change colormap shader definitions in
[`src/lib/shaders/colormapShaders.ts`](src/lib/shaders/colormapShaders.ts),
regenerate the preview swatches:

```sh
python3 scripts/generate_colormap_swatches.py
```

That script requires Pillow:

```sh
pip install Pillow
```

When contributing example data or static assets, keep file sizes reasonable and
prefer formats already used in the repository.

## Pull Request Checklist

Before requesting review, confirm that:

- the change is described clearly in the PR body
- `npm run lint`, `npm run typecheck`, and `npm run build` pass locally
- screenshots are attached for visible UI changes
- commit messages follow the required convention
- generated files are included when your change depends on them

## Questions

If you are unsure about scope, architecture, or dataset-specific behavior, open
an issue or start a draft pull request early so discussion can happen on the
actual code.
