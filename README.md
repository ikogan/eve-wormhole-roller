# EVE Online Wormhole Roller

A static web app for tracking wormhole rolling operations in EVE Online.
No server required — runs from any directory or GitHub Pages.

> [!WARNING]
> This repository was completely vibe coded given the low risk nature of the code.
> I have not reviewed the generated code except a simple passing look. It seems to
> work for me, but use at your own risk, especially the locally run index document.
> In particular, **the YAML import/export code has not been reviewed** — do not load
> YAML files from untrusted sources.

## Live App

| Version | URL |
|---|---|
| **Latest (online)** | https://ikogan.github.io/eve-wormhole-roller/ |
| **Latest offline build** | [Download from Releases](https://github.com/ikogan/eve-wormhole-roller/releases/latest) → `eve-wormhole-roller.html` |

### Branch Previews

Every branch prefixed with `cs/` is automatically deployed to GitHub Pages.
To view a branch in your browser, use the pattern:

```
https://ikogan.github.io/eve-wormhole-roller/preview/cs-<branch-name>/
```

For example, branch `cs/add-feature` is accessible at:
```
https://ikogan.github.io/eve-wormhole-roller/preview/cs-add-feature/
```

## Files

| File | Purpose |
|---|---|
| `index.html` | Online version — loads CSS/JS from source files and Vue 3 & js-yaml from CDN. Served via GitHub Pages. |
| `eve-wormhole-roller.html` | Offline version — all scripts and styles fully inlined. Available in each [Release](https://github.com/ikogan/eve-wormhole-roller/releases). |

## Development Workflow

1. Create a branch named `cs/<description>` (e.g. `cs/add-rorqual`)
2. Make changes — push to trigger an automatic preview deployment
3. Preview at `https://ikogan.github.io/eve-wormhole-roller/preview/cs-<description>/`
4. Open a PR to merge into `main`
5. Merging to `main` publishes a new GitHub Release with `eve-wormhole-roller.html`

## GitHub Pages Setup

1. Push the repository to GitHub.
2. Go to **Settings → Pages → Source** and select **Deploy from a branch**, branch **`gh-pages`**, folder **`/ (root)`**.
3. The release workflow will populate the `gh-pages` branch on next push to `main`.

## Running Locally (offline)

Download `eve-wormhole-roller.html` from the [latest release](https://github.com/ikogan/eve-wormhole-roller/releases/latest) and open it in any browser — no internet connection or web server needed.

## Usage

### Setup Tab
1. Enter your wormhole name and total mass (supports both **kg** and **t** — toggle in the header).
2. Set the wormhole size (Small / Medium / Large / XL / XXL) to filter ships and get compat warnings.
3. Set the current game status (Stable / Reduced / Critical / Collapsed).
4. Add ships to your fleet — each ship needs a **Cold mass** (MWD off) and **Hot mass** (MWD active).
5. Export your fleet to YAML for sharing or importing on another device.

### Roll Tab
- Record each pass as it happens — select a ship and choose Hot or Cold, or enter a custom mass.
- The **mass bar** shows used mass, total mass, and the 0–10% variance zone.
- The stats grid shows how much more mass is needed to reach each threshold.
- Ships too heavy for the configured wormhole size are flagged with a warning before recording.
- Remove individual passes or clear all to reset the session.

### Calculator Tab
- Calculates the optimal (fewest passes, even count) sequence to collapse the wormhole.
- **Best Case** — 0% variance: wormhole is exactly as described (fewest passes needed).
- **Worst Case** — 10% variance: wormhole has 10% more mass than shown (most passes needed).
- Calculated off the main thread — a spinner is shown while computing; no browser freezing.
- Ships excluded by the wormhole size setting are listed and removed from plan options.

## Notes

- **Passes and wormhole config** are saved to `localStorage` and restored on reload.
- **Ships and wormhole config** are saved to `localStorage` automatically.
- **Even pass count** ensures all ships return to the side they started on.
- The 0–10% variance represents the unknown bonus mass the wormhole can sustain above its displayed total.
- All mass values are stored internally in **kg**; YAML export is always in kg regardless of display unit.

## Source Files

```
eve-wormhole-roller/
├── index.html                      Online app (CDN-dependent)
├── css/
│   ├── themes.css                  17 faction theme palettes
│   └── main.css                    App styles
├── js/
│   └── app.js                      Vue 3 app logic + calculator
└── .github/
    ├── scripts/
    │   └── build-offline.py        Inlines CDN scripts → offline HTML
    └── workflows/
        ├── release.yml             Push to main → GitHub Release + Pages deploy
        └── preview.yml             Push to cs/** → Pages preview deploy
```

## Dependencies (loaded via CDN in `index.html`)

- [Vue 3](https://vuejs.org/) — reactive UI
- [js-yaml 4](https://github.com/nodeca/js-yaml) — YAML import/export


