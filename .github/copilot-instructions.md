# GitHub Copilot Instructions

## Local Build — Run After Every Code Change

After any change that affects `index.html`, `js/app.js`, `css/main.css`, or `css/themes.css`, always run:

```bash
bash build-local.sh
```

This regenerates `eve-wormhole-roller.html` for local testing. The file is gitignored. Run it from the repo root.

## GitHub Operations — Always Ask First

**Never perform any of the following without explicit user approval:**

- `git push` (to any remote, any branch)
- `git pull` / `git fetch` from remote
- Creating or pushing branches to GitHub
- Creating or deleting releases or tags
- Any `gh` CLI or API call that modifies GitHub (Pages config, repo settings, releases, etc.)

Local-only git operations (checkout, commit, add, stash, branch creation locally) are fine without asking.

## Branching

- All feature/change work goes on branches named `cs/<description>` (e.g. `cs/add-rorqual`).
- Never commit directly to `main` without explicit user approval.
- After a branch is pushed (with approval), a PR is opened to merge into `main`.

## Project Architecture

This is a **single-file static web app** (`index.html`). Key facts:

- **Runtime deliverable**: `index.html` — all CSS and JS are inlined; only Vue 3 and js-yaml load from CDN.
- **Source files** (`css/`, `js/`) are kept for maintainability but are **not loaded at runtime**.
- After editing source files, changes must be **manually synced into `index.html`** — there is no build step for local development.
- The offline/release build (`eve-wormhole-roller.html`) is produced by `.github/scripts/build-offline.py`, which inlines CDN scripts. This runs in CI only.

## Build Commands

Do not run large build commands (e.g. `docker build`, `skaffold build`) without checking with the user first — large output wastes context. Show the command and ask them to run it.

## CI/CD Workflows

- **`release.yml`**: push to `main` → GitHub Release with `eve-wormhole-roller.html` + deploy `index.html` to `gh-pages` root.
- **`preview.yml`**: push to `cs/**` → deploy to `gh-pages/preview/cs-<branch>/`.
- GitHub Pages is sourced from the `gh-pages` branch, root `/`.

## Key Technical Details

- All mass stored internally in **kg**. UI unit toggle (kg/t) handled via computed setters at edges.
- The calculator runs in a **Web Worker** (Blob URL, works on `file://`) to avoid blocking the UI.
- Wormhole sizes and their max ship mass limits (in kg): Small 5 M, Medium 62 M, Large 375 M, XL 1 B, XXL 2 B.
- Theme selector has 4 optgroups: Empires, Pirate Factions, Organizations, Emergent Factions (17 themes total).
