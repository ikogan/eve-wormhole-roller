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
- Creating, merging, or closing pull requests

**Each approval covers exactly one specific operation.** Approval to push a branch does not imply approval to create a PR. Approval to create a PR does not imply approval to merge it. Always ask separately for each distinct GitHub action, every time.

**Never assume urgency justifies skipping approval** — even for obvious regressions or fixes. This includes when the system indicates the user is unavailable and to "work autonomously" — autonomous work applies only to local operations.

Local-only git operations (checkout, commit, add, stash, local branch creation) are fine without asking.

## Branching

- All feature/change work goes on branches named `cs/<description>` (e.g. `cs/add-rorqual`).
- Never commit directly to `main` without explicit user approval.
- After a branch is pushed (with approval), a PR is opened to merge into `main`.

## Project Architecture

This is a **static web app** served from `index.html`. Key facts:

- **Runtime deliverable**: `index.html` — loads `css/themes.css`, `css/main.css`, and `js/app.js` as external files; Vue 3 and js-yaml load from CDN.
- **Source files** (`css/`, `js/`) are the authoritative source and are loaded directly by `index.html`.
- The offline/release build (`eve-wormhole-roller.html`) is produced by `build-local.sh` / `.github/scripts/build-offline.py`, which inlines all CSS, JS, and CDN scripts into a single file.

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
