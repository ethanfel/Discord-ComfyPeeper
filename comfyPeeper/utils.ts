/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyWithToast } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { showToast, Toasts } from "@webpack/common";

import { settings } from "./settings";
import { webNative } from "./webFallback";

export const logger = new Logger("ComfyPeeper");

// Desktop (Vesktop/Discord desktop) exposes the native main-process module; in a browser
// (Vencord browser extension / Tampermonkey userscript) it's absent, so fall back to the
// renderer implementation (webFallback.ts). Optional chaining avoids a load-time crash on web.
const nativeImpl = (typeof VencordNative !== "undefined"
    ? (VencordNative as any)?.pluginHelpers?.ComfyPeeper
    : undefined) as PluginNative<typeof import("./native")> | undefined;
export const Native = (nativeImpl ?? webNative) as PluginNative<typeof import("./native")>;

export { copyWithToast };

export interface Variant { label?: string; workflow?: string; prompt?: string; }

export interface WorkflowMeta {
    ok: boolean;
    workflow?: string;
    prompt?: string;
    variants?: Variant[]; // present when a file carries more than one embedded graph
    kind?: "png" | "webp" | "video" | "json" | "text" | "unknown";
    error?: string;
}

export type Kind = "png" | "webp" | "video" | "json";

export function kindOf(att: any): Kind | null {
    const ct = (att?.content_type || "").toLowerCase();
    const name = (att?.filename || att?.url || "").toLowerCase().split("?")[0];
    if (ct.includes("png") || name.endsWith(".png")) return "png";
    if (ct.includes("webp") || name.endsWith(".webp")) return "webp";
    if (ct.includes("mp4") || ct.includes("quicktime") || ct.includes("matroska") || ct.includes("webm")
        || /\.(mp4|mov|m4v|webm|mkv)$/.test(name)) return "video";
    if (ct.includes("json") || name.endsWith(".json")) return "json";
    return null;
}

/** Whether an attachment kind has visual media to overlay a badge on / show in the modal. */
export const hasMedia = (kind: Kind) => kind === "png" || kind === "webp" || kind === "video";

const cache = new Map<string, Promise<WorkflowMeta>>();
export function getMeta(att: any, kind: Kind): Promise<WorkflowMeta> {
    const id = String(att.id);
    if (!cache.has(id)) {
        const maxBytes = Math.max(1, settings.store.maxSizeMB) * 1024 * 1024;
        cache.set(id, Native.fetchWorkflow(att.url, maxBytes, kind).catch(e => {
            logger.error("fetchWorkflow failed", e);
            return { ok: false, error: String(e) } as WorkflowMeta;
        }));
    }
    return cache.get(id)!;
}

export interface Endpoint { label: string; url: string; }

export function parseEndpoints(raw: string): Endpoint[] {
    return raw
        .split(/[\n,]/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => {
            const eq = s.indexOf("=");
            if (eq >= 0) return { label: s.slice(0, eq).trim(), url: s.slice(eq + 1).trim() };
            try { return { label: new URL(s).host, url: s }; } catch { return { label: s, url: s }; }
        })
        .filter(e => /^https?:\/\//i.test(e.url));
}

let clientId = "";
export function getClientId() {
    if (!clientId) {
        try { clientId = crypto.randomUUID(); }
        catch { clientId = "vencord-" + Math.random().toString(36).slice(2); }
    }
    return clientId;
}

/** Turn ComfyUI's /prompt error JSON into a short, useful message. */
function describeQueueError(status: number, data: string): string {
    try {
        const j = JSON.parse(data);
        const parts: string[] = [];
        if (j.error?.message) parts.push(j.error.message);
        if (j.node_errors && typeof j.node_errors === "object") {
            for (const [id, ne] of Object.entries<any>(j.node_errors)) {
                const errs = (ne?.errors ?? []).map((e: any) => e.message).join("; ");
                parts.push(`#${id} ${ne?.class_type ?? ""}: ${errs}`.trim());
            }
        }
        if (parts.length) return parts.join(" — ");
    } catch { /* not JSON */ }
    return `${status >= 0 ? `HTTP ${status}` : ""} ${String(data)}`.trim();
}

export async function queue(ep: Endpoint, promptJson: string) {
    showToast(`Queuing on ${ep.label}…`, Toasts.Type.MESSAGE);
    const r = await Native.queuePrompt(ep.url, promptJson, getClientId());
    if (r.ok) { showToast(`Queued on ${ep.label} ✓`, Toasts.Type.SUCCESS); return; }
    logger.warn("queue failed", r);

    // On a validation failure, find out which nodes the server is missing.
    const miss = await Native.getMissingNodes(ep.url, promptJson).catch(() => null);
    if (miss?.ok && miss.missing?.length) {
        showToast(`${ep.label}: missing ${miss.missing.length} node(s) — ${miss.missing.join(", ")}`, Toasts.Type.FAILURE);
    } else {
        showToast(`${ep.label} rejected it: ${describeQueueError(r.status, r.data).slice(0, 220)}`, Toasts.Type.FAILURE);
    }
}

export interface ServerCheck { ep: Endpoint; ok: boolean; missing?: string[]; total?: number; error?: string; }
export async function checkServer(ep: Endpoint, promptJson: string): Promise<ServerCheck> {
    const r = await Native.getMissingNodes(ep.url, promptJson).catch(e => ({ ok: false, error: String(e) }));
    return { ep, ...r };
}

export function downloadJson(name: string, text: string) {
    try {
        const blob = new Blob([text], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
        logger.error("download failed", e);
        showToast("Could not save file", Toasts.Type.FAILURE);
    }
}

export interface ParamNode { id: string; classType: string; inputs: Record<string, string>; }

/** From the API (prompt) graph: each node's named, labelled inputs. */
function paramsFromPrompt(promptJson: string): ParamNode[] {
    const g = JSON.parse(promptJson);
    return Object.entries<any>(g)
        .filter(([, n]) => n && typeof n === "object" && n.class_type)
        .map(([id, n]) => ({
            id,
            classType: n.class_type,
            inputs: Object.fromEntries(
                Object.entries(n.inputs ?? {})
                    .filter(([, v]) => v === null || typeof v !== "object") // drop link refs ([nodeId, slot])
                    .map(([k, v]) => [k, String(v)])
            )
        }));
}

/** Fallback from the editor (workflow) graph: node widget values (labelled if stored as an object). */
function paramsFromWorkflow(workflowJson: string): ParamNode[] {
    const g = JSON.parse(workflowJson);
    if (!Array.isArray(g?.nodes)) return [];
    return g.nodes.map((n: any) => {
        const wv = n?.widgets_values;
        const inputs: Record<string, string> = {};
        if (Array.isArray(wv)) wv.forEach((v, i) => { if (v === null || typeof v !== "object") inputs[`[${i}]`] = String(v); });
        else if (wv && typeof wv === "object") for (const [k, v] of Object.entries(wv)) { if (v === null || typeof v !== "object") inputs[k] = String(v); }
        return { id: String(n?.id ?? "?"), classType: String(n?.title || n?.type || "node"), inputs };
    }).filter((p: ParamNode) => Object.keys(p.inputs).length > 0);
}

/* ---- detect a workflow pasted as raw JSON / a code block in message text ---- */

const MAX_JSON = 4_000_000; // cap balanced-scan length so binary (video) data can't cause O(n²) walks

function balancedObj(text: string, start: number): string | null {
    let depth = 0, inStr = false, esc = false;
    const end = Math.min(text.length, start + MAX_JSON);
    for (let i = start; i < end; i++) {
        const c = text[i];
        if (inStr) {
            if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") inStr = false;
        } else if (c === "\"") inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") { if (--depth === 0) return text.slice(start, i + 1); }
    }
    return null;
}

/** Outermost balanced JSON object that contains char `idx` and parses. */
function enclosingAtIndex(text: string, idx: number): string | undefined {
    for (let s = text.indexOf("{", Math.max(0, idx - MAX_JSON)); s !== -1 && s <= idx; s = text.indexOf("{", s + 1)) {
        const obj = balancedObj(text, s);
        if (obj && s + obj.length > idx) {
            try { JSON.parse(obj); return obj; } catch { /* keep scanning */ }
        }
    }
    return undefined;
}

/** Outermost balanced JSON object containing `marker` that actually parses. */
function enclosingJson(text: string, marker: string): string | undefined {
    const idx = text.indexOf(marker);
    return idx === -1 ? undefined : enclosingAtIndex(text, idx);
}

/** One JSON object → {workflow, prompt}, unwrapping the combined {prompt,workflow} wrapper (VHS video metadata). */
function classifyGraph(jsonText: string): { workflow?: string; prompt?: string; } {
    try {
        const o = JSON.parse(jsonText);
        if (!o || typeof o !== "object" || Array.isArray(o)) return {};
        const norm = (v: any) => v == null ? undefined : (typeof v === "string" ? v : JSON.stringify(v));
        if (!Array.isArray(o.nodes) && (o.workflow != null || o.prompt != null)) {
            const r = { workflow: norm(o.workflow), prompt: norm(o.prompt) };
            if (r.workflow || r.prompt) return r;
        }
        if (Array.isArray(o.nodes)) return { workflow: jsonText };
        if (Object.values(o).some((v: any) => v && typeof v === "object" && v.class_type)) return { prompt: jsonText };
    } catch { /* not json */ }
    return {};
}

function nodeCount(v: Variant): number {
    try {
        if (v.workflow) { const w = JSON.parse(v.workflow); if (Array.isArray(w.nodes)) return w.nodes.length; }
        if (v.prompt) return Object.keys(JSON.parse(v.prompt)).length;
    } catch { /* */ }
    return 0;
}

/** Extract EVERY embedded graph from raw text, ordered (standard tags first, then combined lineage) + labelled. */
export function collectGraphs(text: string): Variant[] {
    const candidates = new Set<string>();
    for (const marker of ["\"workflow\"", "\"last_node_id\"", "\"last_link_id\"", "\"class_type\""]) {
        let idx = text.indexOf(marker);
        for (let g = 0; idx !== -1 && g < 80; g++) {
            const obj = enclosingAtIndex(text, idx);
            if (obj) candidates.add(obj);
            idx = text.indexOf(marker, idx + marker.length);
        }
    }
    const combined: Variant[] = [];
    const wfPool: string[] = [];
    const prPool: string[] = [];
    for (const cand of candidates) {
        const c = classifyGraph(cand);
        if (c.workflow && c.prompt) combined.push(c);
        else if (c.workflow) wfPool.push(c.workflow);
        else if (c.prompt) prPool.push(c.prompt);
    }
    const bare: Variant[] = [];
    for (let i = 0; i < Math.max(wfPool.length, prPool.length); i++) bare.push({ workflow: wfPool[i], prompt: prPool[i] });

    const seen = new Set<string>();
    const out: Variant[] = [];
    for (const v of [...bare, ...combined]) { // bare = current/standard tags first
        if (!v.workflow && !v.prompt) continue;
        const key = (v.workflow?.length ?? 0) + ":" + (v.prompt?.length ?? 0) + ":" + (v.workflow ?? v.prompt ?? "").slice(0, 160);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
    }
    out.forEach((v, i) => { v.label = `Workflow ${i + 1} · ${nodeCount(v)} nodes`; });
    return out;
}

/** Find ComfyUI graph(s) in a message body or file text (raw or in a ``` code block). */
export function findGraphInText(content?: string): WorkflowMeta | null {
    if (!content) return null;
    if (!content.includes("class_type") && !content.includes("last_node_id") && !content.includes("last_link_id")) return null;
    const variants = collectGraphs(content);
    if (!variants.length) return null;
    const p = variants[0]; // primary = the standard/most-recent workflow (what the user added)
    return { ok: true, kind: "text", workflow: p.workflow, prompt: p.prompt, variants: variants.length > 1 ? variants : undefined };
}

/** Per-node parameter list: prefer the labelled API graph, else the editor graph's widget values. */
export function extractParams(promptJson?: string, workflowJson?: string): ParamNode[] {
    if (promptJson) {
        try { const p = paramsFromPrompt(promptJson); if (p.length) return p; } catch { /* fall through */ }
    }
    if (workflowJson) {
        try { return paramsFromWorkflow(workflowJson); } catch { /* none */ }
    }
    return [];
}
