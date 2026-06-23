# ComfyPeeper Companion (ComfyUI extension)

A small ComfyUI extension that pairs with the **[ComfyPeeper](../README.md)** Discord
plugin to enable two things plain ComfyUI's API can't:

- **Send to ComfyUI** — ComfyPeeper can load a workflow straight into your **open ComfyUI
  editor tab** (not just queue it headless).
- **Send to Discord** — right-click an output image in ComfyUI → **📤 Send to Discord**,
  and it's posted to a Discord **webhook** you configure. The image carries its workflow in
  its PNG metadata, so ComfyPeeper detects it on the Discord side.

It also advertises a **friendly name** so ComfyPeeper can label the server and only show
the companion buttons where the companion is actually installed.

## Install

```bash
git clone https://github.com/ethanfel/Discord-ComfyPeeper
cp -r Discord-ComfyPeeper/comfyui-companion <ComfyUI>/custom_nodes/comfypeeper
cp <ComfyUI>/custom_nodes/comfypeeper/config.example.json <ComfyUI>/custom_nodes/comfypeeper/config.json
# edit config.json: set "name", and "discord_webhook" if you want Send to Discord
# restart ComfyUI
```

Verify: `curl http://127.0.0.1:8188/comfypeeper/info` → `{"app":"ComfyPeeper","name":"…",…}`.

## config.json

| key | meaning |
|-----|---------|
| `name` | Friendly name shown by ComfyPeeper (e.g. `"4090 rig"`). |
| `discord_webhook` | A Discord channel **webhook URL** (Channel → Edit → Integrations → Webhooks). Leave empty to disable **Send to Discord**. |

## Routes

| method · path | purpose |
|---------------|---------|
| `GET /comfypeeper/info` | `{ name, version, caps }` — `caps` includes `"send"` only when a webhook is set. |
| `POST /comfypeeper/load` | `{ workflow }` → pushed to open tabs; the frontend loads it. |
| `POST /comfypeeper/send` | `{ filename, subfolder, type }` → uploads that output image to the webhook. |

## Notes

- **Send to ComfyUI** needs a ComfyUI **tab open** to receive the workflow, and the editor
  (`workflow`) graph — which ComfyPeeper has for most posts.
- The webhook URL stays **only** in this `config.json` on your ComfyUI host — it's never
  sent to or stored by the Discord plugin. (`config.json` is git-ignored.)
- The routes are unauthenticated, same trust model as the rest of the ComfyUI server — run
  the companion only on instances you control / trust.
