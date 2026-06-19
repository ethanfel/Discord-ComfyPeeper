<div align="center">

![ComfyPeeper](assets/social-preview.png)

# Discord-ComfyPeeper

**Reveal & run the ComfyUI workflow hidden inside any Discord image, video, or animation.**

A [Vencord](https://vencord.dev) user-plugin that detects ComfyUI metadata embedded in Discord
attachments, badges them, and lets you inspect the node graph, copy/save the JSON, or queue the
workflow straight to a ComfyUI instance — local *or* remote.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-5865f2.svg)](LICENSE)
![Formats](https://img.shields.io/badge/formats-PNG%20%C2%B7%20WebP%20%C2%B7%20MP4%20%C2%B7%20WebM%2FMKV-43b581)
![Client](https://img.shields.io/badge/Vencord%20%2F%20Vesktop-from%20source-5865f2)

</div>

---

## ✨ Features

- **Auto-detect** ComfyUI workflows embedded in **PNG, WebP, MP4/MOV, and WebM/MKV** attachments, with a node-graph badge on the image (or below the message).
- 🔬 **Interactive graph preview** — a faithful node-graph render (pan, zoom-to-cursor, fit) showing each node's title, connections, and widget values.
- 📋 **Parameters view** — every node's settings as a clean, copyable list (seed, steps, cfg, sampler, prompts, LoRAs…).
- 🧾 **Raw JSON** — both the editor `workflow` and the API `prompt` graphs, selectable and copyable.
- 💾 **Copy / Save** the workflow or prompt as `.json`.
- ▶️ **Queue to ComfyUI** — POST the workflow to a running instance, with **one button per configured server** (local and/or remote).
- ✅ **Server compatibility check** — see which of your servers can actually run a workflow, and which **custom nodes are missing** — highlighted **in red on the graph**, just like ComfyUI.

## 📸 Screenshots

<div align="center">
<img src="assets/screenshot-graph.png" alt="Graph view" width="430">
&nbsp;&nbsp;
<img src="assets/screenshot-parameters.png" alt="Parameters view" width="430">
</div>

## 🧠 How it works

ComfyUI saves two graphs in the files it exports:

| graph      | what it is            | used for                                    |
|------------|-----------------------|---------------------------------------------|
| `workflow` | the node-editor graph | the **Graph** preview, Copy / Save          |
| `prompt`   | the API-format graph  | **Queue** (`POST /prompt`), **Parameters**  |

…stored differently per container:

| format     | where the metadata lives                                   |
|------------|------------------------------------------------------------|
| PNG        | `tEXt` / `zTXt` / `iTXt` text chunks                        |
| WebP       | EXIF (`Make` = workflow, `Model` = prompt)                  |
| MP4 / MOV  | the `moov` atom (libav container metadata)                  |
| WebM / MKV | Matroska `Tags` (EBML) — scanned at the file's head & tail  |

All fetching and parsing happens in Vencord's **native (main) process**, so there are no CORS or
mixed-content restrictions — that's why plain-`http` local endpoints work. For videos it fetches
only the metadata region via HTTP **Range** requests, never the whole file. It always reads the
**original** `cdn.discordapp.com` attachment, never the re-encoded `media.discordapp.net` proxy
(which strips metadata).

## 🚀 Install

> Custom plugins require a **Vencord built from source** — the official installer build can't load
> user-plugins. Vesktop users: see the **[full install guide → docs/INSTALL.md](docs/INSTALL.md)**
> (Vesktop ignores the custom-Vencord setting and needs an extra step).

**Quick version (a from-source Vencord):**

```bash
git clone https://github.com/ethanfel/Discord-ComfyPeeper
cp -r Discord-ComfyPeeper/comfyPeeper <Vencord>/src/userplugins/
cd <Vencord> && pnpm build && pnpm inject   # inject only if not already injected
# restart Discord → Settings → Plugins → enable "ComfyPeeper"
```

There's a helper for Vesktop/Vencord that builds and deploys in one step:

```bash
VENCORD_DIR=~/Vencord ./scripts/install-vesktop.sh
```

## ⚙️ Settings

| setting      | description |
|--------------|-------------|
| **endpoints** | Comma-separated ComfyUI servers, optionally labelled: `Local = http://127.0.0.1:8188, Remote = https://gpu.example.com:8188`. A `Queue → <label>` button appears per server. |
| **badgeMode** | `Overlay on the image` (default, falls back to below-message), `Below the message`, or `Both`. |
| **autoScan**  | Auto-scan attachments (default on). Off → a small "Check workflow" button instead (saves bandwidth). |
| **maxSizeMB** | Skip files larger than this when scanning (default 40 MB; videos read only the metadata region). |

## 🧭 Usage

1. Drop (or scroll to) a ComfyUI image/video in any channel → a **ComfyUI workflow** badge appears on it.
2. Click it to open the previewer: **Graph**, **Parameters**, and **JSON** tabs.
3. **Copy / Save** the workflow, or **Queue → \<server\>** to run it.
4. Not sure a server has the right nodes? Hit **Check servers** — green = can run, red = missing nodes (click a red server to highlight the missing nodes on the graph).

## ⚠️ Limitations

- ComfyUI's `/prompt` rejects a workflow if the target server is **missing a custom node** — that
  can't be worked around, only surfaced (use **Check servers**). Install the missing nodes
  (e.g. via ComfyUI-Manager) or pick a server that has them.
- **Queue** runs the API graph headless on the server; it doesn't open the workflow in an editor
  tab (use **Copy/Save** for that). Workflows referencing input images won't auto-upload them.
- In-modal **video playback** for `.mkv` may not work in Chromium, but metadata extraction does.
- Discord strips metadata from re-compressed media; only original-quality attachments are detected.
- Client mods are against Discord's ToS — for personal use.

## 🛠️ Development

The plugin is a standard Vencord user-plugin (`comfyPeeper/`):

| file | role |
|------|------|
| `index.tsx`         | plugin definition, badge + overlay, message accessory |
| `native.ts`         | main-process: fetch + PNG/WebP/MP4/MKV parsing, queue, compat check |
| `WorkflowModal.tsx` | the previewer modal (Graph / Parameters / JSON / actions) |
| `WorkflowGraph.tsx` | the interactive SVG node-graph renderer |
| `settings.ts` · `utils.ts` · `styles.css` | settings, shared helpers, styles |

Build with the standard Vencord toolchain (`pnpm build` / `pnpm test`).

## 📄 License

[GPL-3.0-or-later](LICENSE) — same as Vencord.

Not affiliated with Discord, Vencord, or ComfyUI.
