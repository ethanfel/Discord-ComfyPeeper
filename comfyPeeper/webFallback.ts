/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * ComfyPeeper — renderer (web / userscript) fallback.
 *
 * The desktop build does all network + parsing in the Electron main process
 * (native.ts) to dodge CORS / mixed-content. In a browser there is no main
 * process, so this module reimplements the same surface with plain `fetch`
 * + typed arrays. Discord's CDN sends `access-control-allow-origin: *`, so
 * metadata reads work directly; under a Tampermonkey userscript Vencord
 * rewrites `fetch` → GM_xmlhttpRequest, which also bypasses CORS AND
 * mixed-content, so ComfyUI queueing works too (local and remote http).
 *
 * Keep this byte-for-byte equivalent to native.ts's parsers.
 */

import { collectGraphs, logger, Variant, WorkflowMeta } from "./utils";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/* ------------------------------ byte helpers ------------------------------ */

let _latin1: TextDecoder | null;
try { _latin1 = new TextDecoder("latin1"); } catch { _latin1 = null; }
const _utf8 = new TextDecoder("utf-8");

/** Length-preserving byte→string (latin1). Used for structural JSON scanning + ASCII tags. */
function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
    const sub = bytes.subarray(start, end);
    if (_latin1) return _latin1.decode(sub);
    let out = "";
    for (let i = 0; i < sub.length; i += 0x8000) out += String.fromCharCode.apply(null, [...sub.subarray(i, i + 0x8000)]);
    return out;
}
const ascii = latin1; // our ASCII tag/fourcc reads are all < 0x80
const utf8 = (bytes: Uint8Array, start = 0, end = bytes.length) => _utf8.decode(bytes.subarray(start, end));
const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** zlib inflate via the browser's DecompressionStream (zTXt / iTXt chunks). */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
    const DS = (globalThis as any).DecompressionStream;
    if (!DS) throw new Error("DecompressionStream unavailable");
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DS("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, [...bytes.subarray(i, i + 0x8000)]);
    return btoa(bin);
}

function metaFromVariants(variants: Variant[], kind: WorkflowMeta["kind"]): WorkflowMeta {
    if (!variants.length) return { ok: false, kind };
    const p = variants[0];
    return { ok: true, kind, workflow: p.workflow, prompt: p.prompt, variants: variants.length > 1 ? variants : undefined };
}

/* --------------------------------- PNG ------------------------------------ */

async function parsePng(bytes: Uint8Array): Promise<{ workflow?: string; prompt?: string; }> {
    for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return {};
    const view = dv(bytes);
    const chunks: Record<string, string> = {};
    let off = 8;
    while (off + 8 <= bytes.length) {
        const len = view.getUint32(off, false);
        const type = ascii(bytes, off + 4, off + 8);
        const dataStart = off + 8;
        const dataEnd = dataStart + len;
        if (dataEnd > bytes.length) break;
        const data = bytes.subarray(dataStart, dataEnd);
        try {
            if (type === "tEXt") {
                const sep = data.indexOf(0);
                if (sep >= 0) chunks[latin1(data, 0, sep)] = latin1(data, sep + 1);
            } else if (type === "zTXt") {
                const sep = data.indexOf(0);
                if (sep >= 0) chunks[latin1(data, 0, sep)] = utf8(await inflate(data.subarray(sep + 2)));
            } else if (type === "iTXt") {
                const sep = data.indexOf(0);
                if (sep >= 0) {
                    const key = latin1(data, 0, sep);
                    const compFlag = data[sep + 1];
                    let p = sep + 3;
                    p = data.indexOf(0, p) + 1; // language tag
                    p = data.indexOf(0, p) + 1; // translated keyword
                    const text = data.subarray(p);
                    chunks[key] = compFlag === 1 ? utf8(await inflate(text)) : utf8(text);
                }
            }
        } catch { /* skip malformed chunk */ }
        if (type === "IEND") break;
        off = dataEnd + 4;
    }
    return { workflow: chunks.workflow, prompt: chunks.prompt };
}

/* -------------------------------- WebP ------------------------------------ */

function parseExifAscii(exif: Uint8Array): Record<number, string> {
    let tiff = exif;
    if (exif.length >= 6 && ascii(exif, 0, 4) === "Exif") tiff = exif.subarray(6);
    if (tiff.length < 8) return {};
    const view = dv(tiff);
    const bom = ascii(tiff, 0, 2);
    const le = bom === "II";
    if (!le && bom !== "MM") return {};
    const rd16 = (o: number) => view.getUint16(o, le);
    const rd32 = (o: number) => view.getUint32(o, le);

    const out: Record<number, string> = {};
    const ifd = rd32(4);
    if (ifd + 2 > tiff.length) return out;
    const count = rd16(ifd);
    for (let i = 0; i < count; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > tiff.length) break;
        const tag = rd16(e);
        const type = rd16(e + 2);
        const cnt = rd32(e + 4);
        if (type !== 2) continue; // ASCII only
        const o = cnt <= 4 ? e + 8 : rd32(e + 8);
        if (o + cnt > tiff.length) continue;
        out[tag] = utf8(tiff, o, o + cnt).replace(/\0+$/, "");
    }
    return out;
}

function parseWebp(bytes: Uint8Array): { workflow?: string; prompt?: string; } {
    if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP") return {};
    const view = dv(bytes);
    let off = 12;
    let exif: Uint8Array | null = null;
    while (off + 8 <= bytes.length) {
        const fourcc = ascii(bytes, off, off + 4);
        const size = view.getUint32(off + 4, true);
        const dataStart = off + 8;
        if (dataStart + size > bytes.length) break;
        if (fourcc === "EXIF") { exif = bytes.subarray(dataStart, dataStart + size); break; }
        off = dataStart + size + (size & 1); // chunks padded to even size
    }
    if (!exif) return {};

    const tags = parseExifAscii(exif);
    const res: { workflow?: string; prompt?: string; } = {};
    for (const v of Object.values(tags)) {
        const colon = v.indexOf(":");
        if (colon < 0) continue;
        const key = v.slice(0, colon).trim().toLowerCase();
        const val = v.slice(colon + 1);
        if (key === "workflow") res.workflow = val;
        else if (key === "prompt") res.prompt = val;
    }
    return res;
}

/* ------------------------------ video (range) ----------------------------- */

async function fetchRange(url: string, start: number, end: number, maxBytes: number): Promise<{ bytes: Uint8Array; full: boolean; } | null> {
    try {
        const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
        if (!res.ok) return null;
        const len = Number(res.headers.get("content-length") ?? 0);
        if (res.status === 200 && len && len > maxBytes) return null; // server ignored Range, file too big
        return { bytes: new Uint8Array(await res.arrayBuffer()), full: res.status === 200 };
    } catch { return null; }
}

async function fetchTail(url: string, n: number, maxBytes: number): Promise<Uint8Array | null> {
    try {
        const res = await fetch(url, { headers: { Range: `bytes=-${n}` } });
        if (!res.ok) return null;
        const len = Number(res.headers.get("content-length") ?? 0);
        if (res.status === 200 && len && len > maxBytes) return null;
        return new Uint8Array(await res.arrayBuffer());
    } catch { return null; }
}

function findBox(bytes: Uint8Array, type: string): Uint8Array | null {
    const view = dv(bytes);
    let o = 0;
    while (o + 8 <= bytes.length) {
        let size = view.getUint32(o, false);
        const t = ascii(bytes, o + 4, o + 8);
        if (size === 1) {
            if (o + 16 > bytes.length) break;
            size = Number(view.getBigUint64(o + 8, false));
        }
        if (size === 0) size = bytes.length - o;
        if (size < 8) break;
        if (t === type) return bytes.subarray(o, Math.min(o + size, bytes.length));
        o += size;
    }
    return null;
}

async function locateMoov(url: string, maxBytes: number): Promise<Uint8Array | null> {
    let offset = 0;
    for (let guard = 0; guard < 256; guard++) {
        const head = await fetchRange(url, offset, offset + 15, maxBytes);
        if (!head) return null;
        if (head.full) return findBox(head.bytes, "moov");
        const b = head.bytes;
        if (b.length < 8) return null;
        const view = dv(b);
        let size = view.getUint32(0, false);
        const type = ascii(b, 4, 8);
        if (size === 1) {
            if (b.length < 16) return null;
            size = Number(view.getBigUint64(8, false));
        }
        if (type === "moov") {
            if (size <= 0 || size > maxBytes) return null;
            const full = await fetchRange(url, offset, offset + size - 1, maxBytes);
            return full ? full.bytes : null;
        }
        if (size <= 0) return null;
        offset += size;
    }
    return null;
}

async function fetchVideoMeta(url: string, maxBytes: number): Promise<WorkflowMeta> {
    const probe = await fetchRange(url, 0, 15, maxBytes);
    const b = probe?.bytes;
    const isEbml = !!b && b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    if (isEbml) {
        const win = Math.min(maxBytes, 8 * 1024 * 1024);
        const head = await fetchRange(url, 0, win - 1, maxBytes);
        let text = head ? latin1(head.bytes) : "";
        if (!head?.full) {
            const tail = await fetchTail(url, win, maxBytes);
            if (tail) text += "\n" + latin1(tail);
        }
        return metaFromVariants(collectGraphs(text), "video");
    }
    const moov = await locateMoov(url, maxBytes);
    if (!moov) return { ok: false, kind: "video", error: "no moov atom found within size limit" };
    return metaFromVariants(collectGraphs(latin1(moov)), "video");
}

/* --------------------------------- API ------------------------------------ */
/* Signatures match PluginNative<native> (the IPC event arg is stripped on the renderer side). */

async function fetchWorkflow(url: string, maxBytes: number, kind: "png" | "webp" | "video" | "json" | "auto"): Promise<WorkflowMeta> {
    try {
        if (kind === "video") return await fetchVideoMeta(url, maxBytes);

        if (kind === "json") {
            const res = await fetch(url);
            if (!res.ok) return { ok: false, kind: "json", error: `HTTP ${res.status}` };
            const len = Number(res.headers.get("content-length") ?? 0);
            if (maxBytes && len && len > maxBytes) return { ok: false, kind: "json", error: "too large" };
            const text = await res.text();
            if (maxBytes && text.length > maxBytes) return { ok: false, kind: "json", error: "too large" };
            const variants = collectGraphs(text);
            return variants.length ? metaFromVariants(variants, "json") : { ok: false, kind: "json" };
        }

        const res = await fetch(url);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const declared = Number(res.headers.get("content-length") ?? 0);
        if (maxBytes && declared && declared > maxBytes) return { ok: false, error: "too large" };
        const ab = await res.arrayBuffer();
        if (maxBytes && ab.byteLength > maxBytes) return { ok: false, error: "too large" };
        const bytes = new Uint8Array(ab);

        const isPng = PNG_SIG.every((s, i) => bytes[i] === s);
        const isWebp = ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";

        let r: { workflow?: string; prompt?: string; } = {};
        let detected: WorkflowMeta["kind"] = "unknown";
        if (isPng) { r = await parsePng(bytes); detected = "png"; }
        else if (isWebp) { r = parseWebp(bytes); detected = "webp"; }

        if (!r.workflow && !r.prompt) {
            const variants = collectGraphs(latin1(bytes)); // generic fallback
            return variants.length ? metaFromVariants(variants, detected) : { ok: false, kind: detected };
        }
        return { ok: true, kind: detected, workflow: r.workflow, prompt: r.prompt };
    } catch (e) {
        logger.error("web fetchWorkflow failed", e);
        return { ok: false, error: String(e) };
    }
}

async function queuePrompt(endpoint: string, promptJson: string, clientId: string): Promise<{ ok: boolean; status: number; data: string; }> {
    try {
        const base = endpoint.replace(/\/+$/, "");
        const prompt = JSON.parse(promptJson);
        const res = await fetch(`${base}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt, client_id: clientId })
        });
        return { ok: res.ok, status: res.status, data: await res.text() };
    } catch (e) {
        return { ok: false, status: -1, data: String(e) };
    }
}

async function getMissingNodes(endpoint: string, promptJson: string): Promise<{ ok: boolean; missing?: string[]; total?: number; error?: string; }> {
    try {
        const base = endpoint.replace(/\/+$/, "");
        const res = await fetch(`${base}/object_info`);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const info = await res.json();
        const have = new Set(Object.keys(info));
        const used = new Set<string>();
        for (const n of Object.values<any>(JSON.parse(promptJson))) {
            if (n && typeof n === "object" && typeof n.class_type === "string") used.add(n.class_type);
        }
        const missing = [...used].filter(t => !have.has(t)).sort();
        return { ok: true, missing, total: used.size };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

/* ----------------------- advanced mode: LoRA presence --------------------- */

function collectLoraNames(info: any): string[] {
    const out = new Set<string>();
    const nodes = info && info.input ? [info] : Object.values<any>(info ?? {});
    for (const node of nodes) {
        const specs = { ...(node?.input?.required ?? {}), ...(node?.input?.optional ?? {}) };
        for (const [k, def] of Object.entries<any>(specs)) {
            if (!/lora/i.test(k)) continue;
            const options = Array.isArray(def) ? def[0] : undefined;
            if (Array.isArray(options)) for (const o of options) if (typeof o === "string") out.add(o);
        }
    }
    return [...out];
}

async function getLoraInventory(endpoint: string): Promise<{ ok: boolean; loras?: string[]; error?: string; }> {
    try {
        const base = endpoint.replace(/\/+$/, "");
        let res = await fetch(`${base}/object_info/LoraLoader`);
        if (!res.ok) res = await fetch(`${base}/object_info`);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        return { ok: true, loras: collectLoraNames(await res.json()) };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

async function loraManagerProbe(endpoint: string): Promise<{ present: boolean; }> {
    const base = endpoint.replace(/\/+$/, "");
    for (const p of ["/api/lm/loras/list?page_size=1", "/api/loras/list?page_size=1"]) {
        try { if ((await fetch(base + p)).ok) return { present: true }; } catch { /* try next */ }
    }
    return { present: false };
}

async function loraManagerDownload(endpoint: string, versionId: string, modelId?: string, source?: string): Promise<{ ok: boolean; status: number; data: string; }> {
    const base = endpoint.replace(/\/+$/, "");
    const body: Record<string, unknown> = { use_default_paths: true };
    if (versionId) body.model_version_id = Number(versionId);
    if (modelId) body.model_id = Number(modelId);
    if (source) body.source = source;
    let last = { ok: false, status: -1, data: "LoRA Manager download endpoint not found" };
    for (const p of ["/api/lm/download-model", "/api/download-model"]) {
        try {
            const res = await fetch(base + p, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
            const data = await res.text();
            if (res.status !== 404) return { ok: res.ok, status: res.status, data };
            last = { ok: false, status: 404, data };
        } catch (e) {
            last = { ok: false, status: -1, data: String(e) };
        }
    }
    return last;
}

async function fetchBytes(url: string, maxBytes: number): Promise<{ ok: boolean; base64?: string; error?: string; }> {
    try {
        const res = await fetch(url);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const len = Number(res.headers.get("content-length") ?? 0);
        if (maxBytes && len && len > maxBytes) return { ok: false, error: "too large" };
        const ab = await res.arrayBuffer();
        if (maxBytes && ab.byteLength > maxBytes) return { ok: false, error: "too large" };
        return { ok: true, base64: toBase64(new Uint8Array(ab)) };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

/** Drop-in replacement for VencordNative.pluginHelpers.ComfyPeeper when running in a browser. */
export const webNative = { fetchWorkflow, queuePrompt, getMissingNodes, fetchBytes, getLoraInventory, loraManagerProbe, loraManagerDownload };
