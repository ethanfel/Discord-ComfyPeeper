"""
ComfyPeeper Companion — bridges ComfyUI with the ComfyPeeper Discord plugin.

Drop this folder into ComfyUI/custom_nodes/ (as `comfypeeper`) and restart ComfyUI.
It adds three routes on the ComfyUI server:

  GET  /comfypeeper/info   advertise a friendly name + capabilities (so the plugin can
                           label this server and light up companion features)
  POST /comfypeeper/load   { workflow }  -> push the workflow to open editor tabs, which
                           the bundled frontend extension loads via app.loadGraphData()
  POST /comfypeeper/send   { filename, subfolder, type } -> upload that output image to
                           the configured Discord webhook (the image carries its workflow
                           in PNG metadata, so ComfyPeeper detects it on the Discord side)

Configure by copying config.example.json -> config.json and setting `name` (and
`discord_webhook` if you want "Send to Discord").
"""

import json
import os

import aiohttp
from aiohttp import web

import folder_paths
from server import PromptServer

VERSION = "1.0.0"
_DIR = os.path.dirname(os.path.realpath(__file__))
_CONFIG_PATH = os.path.join(_DIR, "config.json")


def _config():
    try:
        with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}
    return {
        "name": (cfg.get("name") or "ComfyUI").strip(),
        "discord_webhook": (cfg.get("discord_webhook") or "").strip(),
    }


def _resolve_image_path(filename, subfolder, type_):
    """Resolve a /view-style image ref to a file path, clamped inside the type's base dir."""
    if not filename:
        return None
    base = folder_paths.get_directory_by_type(type_ or "output")
    if not base:
        return None
    base = os.path.abspath(base)
    target = os.path.abspath(os.path.join(base, subfolder or "", filename))
    # block path traversal outside the base directory
    if os.path.commonpath([base, target]) != base:
        return None
    return target if os.path.isfile(target) else None


routes = PromptServer.instance.routes


@routes.get("/comfypeeper/info")
async def comfypeeper_info(_request):
    cfg = _config()
    caps = ["load"]
    if cfg["discord_webhook"]:
        caps.append("send")
    return web.json_response({"app": "ComfyPeeper", "name": cfg["name"], "version": VERSION, "caps": caps})


@routes.post("/comfypeeper/load")
async def comfypeeper_load(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)
    workflow = data.get("workflow")
    if workflow is None:
        return web.json_response({"ok": False, "error": "no workflow"}, status=400)
    # broadcast to every connected tab; the frontend extension calls app.loadGraphData()
    PromptServer.instance.send_sync("comfypeeper.load", {"workflow": workflow})
    return web.json_response({"ok": True})


@routes.post("/comfypeeper/send")
async def comfypeeper_send(request):
    webhook = _config()["discord_webhook"]
    if not webhook:
        return web.json_response({"ok": False, "error": "no webhook configured"}, status=400)
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)

    path = _resolve_image_path(data.get("filename"), data.get("subfolder", ""), data.get("type", "output"))
    if not path:
        return web.json_response({"ok": False, "error": "image not found"}, status=404)

    try:
        with open(path, "rb") as f:
            file_bytes = f.read()
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)

    content = (data.get("content") or "").strip()
    form = aiohttp.FormData()
    form.add_field("payload_json", json.dumps({"content": content}))
    form.add_field("files[0]", file_bytes, filename=os.path.basename(path), content_type="application/octet-stream")
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(webhook, data=form) as resp:
                body = await resp.text()
                return web.json_response({"ok": resp.status in (200, 204), "status": resp.status, "data": body[:300]})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS", "WEB_DIRECTORY"]

print(f"[ComfyPeeper] companion loaded (v{VERSION}) — name: {_config()['name']!r}")
