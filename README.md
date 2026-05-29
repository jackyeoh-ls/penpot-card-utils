# Card Exporter Plugin — Penpot Edition

A direct port of the Figma Card Exporter plugin for **Penpot**. All four tabs and their functionality are preserved 1:1.

## Prerequisites

* **Penpot Desktop or Web** — Penpot supports plugins natively (no separate app required).
* Plugin support is enabled by default on [penpot.app](https://penpot.app) and self-hosted instances ≥ 2.3.

## Installation

1. **Download the plugin folder** (the folder containing `manifest.json`, `code.js`, and `ui.html`).
2. Open any Penpot file.
3. Click the **Penpot menu** (top-left logo) → **Plugins** → **Plugin manager**.
4. Click **Install new plugin** and paste the URL, *or* drag `manifest.json` into the dialog (local file loading may vary by instance — see your admin).
5. The plugin appears in the Plugins list — click **Open** to run it.

## How to Use

Open via **Main menu → Plugins → Card Exporter**. The panel has five tabs:

### 1. JSON (Data & Images)
* **Select Page** — choose the Penpot page that contains your card frames.
* **Smart Scan** — exports changed cards only (compares against the cached last run).
* **Force Full Scan** — re-exports everything from scratch.
* **Download ZIP** — packages `cards.json` + a folder of PNG images into a `.zip` file.

### 2. Sync (Design Management)
* **Source** — the "Master" page with correct text/data.
* **Target** — the layout page to update.
* Cards are matched by their layer name (`card-1`, `card-2`, …). Positions on the target page are preserved.

### 3. Minidecks (Deck Building)
* Scans for the nesting structure: `Deck Frame` → `Rarity Group` → `Card Frames`.
* Outputs a JSON array of decks with card names, rarities, costs, and types.
* Copy the JSON for use in the TCG Arena minideck simulator.

### 4. Stats & Analysis (Balancing)
* Analyzes all `card-*` frames on a page.
* Displays Average Cost, Average DMG, DMG-per-AP, Attack%, and defensive card stats.
* **Filters** by Type, Cost, Keyword, and Body Part (Head / Body / Leg).
* **Tallies** break down keyword and type counts across the filtered set.

### 5. Transform
* Finds a **Component named "Card"** anywhere in the document.
* Creates new instances of that component for every `card-*` frame on the selected page, populating text layers (`AP Cost Text`, `Card Name`, `Card Type Text`, `Card Effect Text`, `Card Value Text`) from the parsed card data.
* Instances are placed to the right of the originals at the same relative positions.

## Layer / Naming Conventions

These match the Figma version exactly:

| Pattern | Meaning |
|---|---|
| `card-1`, `card-2`, … | Numbered card frames |
| `card-?` or `card-x` | Unnumbered cards (auto-assigned next available ID) |
| `token-slug-name` | Token frames |
| Text `3 AP` | AP cost |
| Text `5 DMG` or `- DMG` | Damage value |
| Text `Block 3` / `20% Block` | Block value |
| Text `Dodge 2` | Dodge value (stored as negative block) |
| Text `Attack(Melee) Description…` | Card type + effect text |
| Text `Head Body` etc. | Zone targets |

## Differences from the Figma Version

| Feature | Figma | Penpot |
|---|---|---|
| Text content API | `layer.characters` + `getStyledTextSegments` | `shape.content` rich-text tree |
| Storage | `figma.clientStorage` | `penpot.clientStorage` |
| Page access | `figma.getNodeByIdAsync` | `penpot.getPage(id)` |
| Image export | `node.exportAsync` | `shape.export({ type:'png' })` |
| Bold detection | Font style segment API | Walk content tree, check `fontWeight ≥ 700` |
| Component instances | `component.createInstance()` | `component.clone()` (Penpot approach) |
| Message passing | `figma.ui.postMessage` / `figma.ui.onmessage` | `penpot.ui.sendMessage` / `penpot.ui.onMessage` |

## Troubleshooting

* **"Page not found"** — make sure the correct page is selected in the dropdown.
* **No cards found** — verify your frames follow the `card-N` naming convention and are within the configured scan depth (default: 3 levels deep).
* **Bold keywords not detected** — Penpot's bold detection walks the rich-text content tree and checks `fontWeight ≥ 700`. Ensure your bold text uses a weight of 700+ in Penpot's text properties.
* **Transform: "Could not find component"** — a frame or component named exactly `Card` must exist somewhere in the document's component library.
