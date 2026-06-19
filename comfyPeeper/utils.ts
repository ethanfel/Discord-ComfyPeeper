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

export const Native = VencordNative.pluginHelpers.ComfyPeeper as PluginNative<typeof import("./native")>;
export const logger = new Logger("ComfyPeeper");

export { copyWithToast };

export interface WorkflowMeta {
    ok: boolean;
    workflow?: string;
    prompt?: string;
    kind?: "png" | "webp" | "video" | "json" | "unknown";
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
