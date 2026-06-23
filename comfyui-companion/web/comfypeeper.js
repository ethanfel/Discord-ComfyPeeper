import { app } from "../../scripts/app.js";

/*
 * ComfyPeeper companion — frontend extension.
 *  - listens for "comfypeeper.load" (pushed by POST /comfypeeper/load) and loads the
 *    workflow into this open tab via app.loadGraphData()
 *  - adds a "Send to Discord" right-click item to image-output nodes, which POSTs the
 *    image ref to /comfypeeper/send (the server uploads it to the configured webhook)
 */

function toast(severity, detail) {
    try { app.extensionManager?.toast?.add?.({ severity, summary: "ComfyPeeper", detail, life: 4000 }); }
    catch { /* older ComfyUI: no toast API */ }
    if (severity === "error") console.error("[ComfyPeeper]", detail);
}

/** Parse a ComfyUI image element src (/view?filename=..&subfolder=..&type=..) into a ref. */
function imgRef(src) {
    try {
        const u = new URL(src, window.location.origin);
        const filename = u.searchParams.get("filename");
        if (!filename) return null;
        return { filename, subfolder: u.searchParams.get("subfolder") || "", type: u.searchParams.get("type") || "output" };
    } catch { return null; }
}

async function sendToDiscord(node) {
    const imgs = node?.imgs || [];
    const src = imgs[node.imageIndex ?? 0]?.src || imgs[0]?.src;
    const ref = src && imgRef(src);
    if (!ref) { toast("error", "No image on this node to send"); return; }
    try {
        const r = await app.api.fetchApi("/comfypeeper/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(ref)
        });
        const j = await r.json().catch(() => ({}));
        if (j?.ok) toast("success", "Sent to Discord");
        else toast("error", "Send failed: " + (j?.error || ("HTTP " + r.status)));
    } catch (err) {
        toast("error", "Send failed: " + err);
    }
}

app.registerExtension({
    name: "comfypeeper.companion",

    async setup() {
        app.api.addEventListener("comfypeeper.load", async e => {
            const wf = e?.detail?.workflow;
            if (!wf) return;
            try {
                await app.loadGraphData(typeof wf === "string" ? JSON.parse(wf) : wf);
                toast("success", "Workflow loaded from Discord");
            } catch (err) {
                toast("error", "Couldn't load that workflow");
            }
        });
    },

    // add "Send to Discord" to image-bearing nodes. getExtraMenuOptions is the most broadly
    // compatible hook today (newer ComfyUI shows a deprecation notice but still honours it).
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!["SaveImage", "PreviewImage"].includes(nodeData?.name)) return;
        const orig = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            orig?.apply(this, arguments);
            if ((this.imgs || []).length) options.push({ content: "📤 Send to Discord", callback: () => sendToDiscord(this) });
        };
    }
});
