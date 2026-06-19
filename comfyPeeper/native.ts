/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * ComfyPeeper — native (Electron main / Node) module.
 *
 * Runs in the main process, so there is no CORS / mixed-content restriction:
 *  - fetchWorkflow() downloads the attachment and extracts embedded ComfyUI
 *    metadata from PNG (tEXt/zTXt/iTXt), WebP (EXIF), or MP4/MOV (moov atom).
 *  - queuePrompt() POSTs the API graph to a ComfyUI instance (/prompt),
 *    over http (local) or https (remote).
 *
 * ComfyUI stores two graphs:
 *   workflow → litegraph editor graph (drag/Load into the UI)
 *   prompt   → API graph (what /prompt accepts to actually queue a run)
 */

import type { IpcMainInvokeEvent } from "electron";
import { inflateSync } from "zlib";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface WorkflowMeta {
    ok: boolean;
    workflow?: string;
    prompt?: string;
    kind?: "png" | "webp" | "video" | "json" | "unknown";
    error?: string;
}

/* ----------------------------- generic helpers ---------------------------- */

/** Walk a string from `start` ('{') and return the balanced JSON object substring. */
function balancedObject(text: string, start: number): string | null {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === "\\") esc = true;
            else if (c === "\"") inStr = false;
        } else if (c === "\"") {
            inStr = true;
        } else if (c === "{") {
            depth++;
        } else if (c === "}") {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return null;
}

/** Find the OUTERMOST balanced JSON object that contains `marker` and parses. */
function extractEnclosingJson(text: string, marker: string): string | undefined {
    const markerIdx = text.indexOf(marker);
    if (markerIdx === -1) return undefined;
    for (let s = text.indexOf("{"); s !== -1 && s <= markerIdx; s = text.indexOf("{", s + 1)) {
        const obj = balancedObject(text, s);
        if (obj && s + obj.length > markerIdx) {
            try { JSON.parse(obj); return obj; } catch { /* not this one */ }
        }
    }
    return undefined;
}

/** Last-resort: recover graphs from raw text by their signature keys. */
function scanText(text: string): { workflow?: string; prompt?: string; } {
    // prompt (API) graph: only API graphs contain "class_type"
    const prompt = extractEnclosingJson(text, "\"class_type\"");
    // workflow (editor) graph: litegraph top-level key
    const workflow = extractEnclosingJson(text, "\"last_node_id\"")
        ?? extractEnclosingJson(text, "\"last_link_id\"");
    return { workflow, prompt };
}

/* --------------------------------- PNG ------------------------------------ */

function parsePng(buf: Buffer): { workflow?: string; prompt?: string; } {
    for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) return {};
    const chunks: Record<string, string> = {};
    let off = 8;
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString("ascii", off + 4, off + 8);
        const dataStart = off + 8;
        const dataEnd = dataStart + len;
        if (dataEnd > buf.length) break;
        const data = buf.subarray(dataStart, dataEnd);
        try {
            if (type === "tEXt") {
                const sep = data.indexOf(0);
                if (sep >= 0) chunks[data.toString("latin1", 0, sep)] = data.toString("latin1", sep + 1);
            } else if (type === "zTXt") {
                const sep = data.indexOf(0);
                if (sep >= 0) chunks[data.toString("latin1", 0, sep)] = inflateSync(data.subarray(sep + 2)).toString("utf8");
            } else if (type === "iTXt") {
                const sep = data.indexOf(0);
                if (sep >= 0) {
                    const key = data.toString("latin1", 0, sep);
                    const compFlag = data[sep + 1];
                    let p = sep + 3;
                    p = data.indexOf(0, p) + 1; // language tag
                    p = data.indexOf(0, p) + 1; // translated keyword
                    const text = data.subarray(p);
                    chunks[key] = compFlag === 1 ? inflateSync(text).toString("utf8") : text.toString("utf8");
                }
            }
        } catch { /* skip malformed chunk */ }
        if (type === "IEND") break;
        off = dataEnd + 4;
    }
    return { workflow: chunks.workflow, prompt: chunks.prompt };
}

/* -------------------------------- WebP ------------------------------------ */

/** Parse EXIF (TIFF) ASCII tags into a tag→string map. */
function parseExifAscii(exif: Buffer): Record<number, string> {
    let tiff = exif;
    if (exif.length >= 6 && exif.toString("ascii", 0, 4) === "Exif") tiff = exif.subarray(6);
    if (tiff.length < 8) return {};
    const bom = tiff.toString("ascii", 0, 2);
    const le = bom === "II";
    if (!le && bom !== "MM") return {};
    const rd16 = (o: number) => le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o);
    const rd32 = (o: number) => le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o);

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
        const off = cnt <= 4 ? e + 8 : rd32(e + 8);
        if (off + cnt > tiff.length) continue;
        out[tag] = tiff.toString("utf8", off, off + cnt).replace(/\0+$/, "");
    }
    return out;
}

function parseWebp(buf: Buffer): { workflow?: string; prompt?: string; } {
    if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return {};
    let off = 12;
    let exif: Buffer | null = null;
    while (off + 8 <= buf.length) {
        const fourcc = buf.toString("ascii", off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        const dataStart = off + 8;
        if (dataStart + size > buf.length) break;
        if (fourcc === "EXIF") { exif = buf.subarray(dataStart, dataStart + size); break; }
        off = dataStart + size + (size & 1); // chunks are padded to even size
    }
    if (!exif) return {};

    const tags = parseExifAscii(exif);
    const res: { workflow?: string; prompt?: string; } = {};
    // ComfyUI stores values as "key:<json>"; key is the prefix before the first colon.
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

/* ------------------------------ MP4 / MOV --------------------------------- */

async function fetchRange(url: string, start: number, end: number, maxBytes: number): Promise<{ buf: Buffer; full: boolean; } | null> {
    try {
        const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
        if (!res.ok) return null;
        const len = Number(res.headers.get("content-length") ?? 0);
        if (res.status === 200 && len && len > maxBytes) return null; // server ignored Range and file is too big
        const ab = await res.arrayBuffer();
        return { buf: Buffer.from(ab), full: res.status === 200 };
    } catch {
        return null;
    }
}

/** Walk top-level boxes of `buf` to find one of the given type. */
function findBox(buf: Buffer, type: string): Buffer | null {
    let o = 0;
    while (o + 8 <= buf.length) {
        let size = buf.readUInt32BE(o);
        const t = buf.toString("latin1", o + 4, o + 8);
        if (size === 1) {
            if (o + 16 > buf.length) break;
            size = Number(buf.readBigUInt64BE(o + 8));
        }
        if (size === 0) size = buf.length - o;
        if (size < 8) break;
        if (t === type) return buf.subarray(o, Math.min(o + size, buf.length));
        o += size;
    }
    return null;
}

/** Locate the `moov` atom, fetching only its bytes via Range requests when possible. */
async function locateMoov(url: string, maxBytes: number): Promise<Buffer | null> {
    let offset = 0;
    for (let guard = 0; guard < 256; guard++) {
        const head = await fetchRange(url, offset, offset + 15, maxBytes);
        if (!head) return null;
        if (head.full) return findBox(head.buf, "moov"); // ranges unsupported: whole (capped) file
        const b = head.buf;
        if (b.length < 8) return null;
        let size = b.readUInt32BE(0);
        const type = b.toString("latin1", 4, 8);
        if (size === 1) {
            if (b.length < 16) return null;
            size = Number(b.readBigUInt64BE(8));
        }
        if (type === "moov") {
            if (size <= 0 || size > maxBytes) return null;
            const full = await fetchRange(url, offset, offset + size - 1, maxBytes);
            return full ? full.buf : null;
        }
        if (size <= 0) return null; // box-to-EOF before moov: cannot seek past
        offset += size;
    }
    return null;
}

async function fetchMp4Meta(url: string, maxBytes: number): Promise<WorkflowMeta> {
    const moov = await locateMoov(url, maxBytes);
    if (!moov) return { ok: false, kind: "video", error: "no moov atom found within size limit" };
    const { workflow, prompt } = scanText(moov.toString("latin1"));
    if (!workflow && !prompt) return { ok: false, kind: "video" };
    return { ok: true, kind: "video", workflow, prompt };
}

/* ------------------------------ WebM / MKV -------------------------------- */

/** Fetch the last `n` bytes of a resource via an HTTP suffix range. */
async function fetchTail(url: string, n: number, maxBytes: number): Promise<Buffer | null> {
    try {
        const res = await fetch(url, { headers: { Range: `bytes=-${n}` } });
        if (!res.ok) return null;
        const len = Number(res.headers.get("content-length") ?? 0);
        if (res.status === 200 && len && len > maxBytes) return null; // ignored suffix range, too big
        return Buffer.from(await res.arrayBuffer());
    } catch {
        return null;
    }
}

/*
 * Matroska (WebM/MKV) stores ComfyUI metadata as UTF-8 inside a Tags element (or an
 * attached workflow file), which libav/ffmpeg place near the start OR the end of the
 * file. EBML element sizes are variable-length, so rather than walk the tree we fetch a
 * head + tail window (skipping the big middle clusters) and text-scan for the graphs.
 */
async function fetchMatroskaMeta(url: string, maxBytes: number): Promise<WorkflowMeta> {
    const window = Math.min(maxBytes, 8 * 1024 * 1024);
    let workflow: string | undefined;
    let prompt: string | undefined;

    const head = await fetchRange(url, 0, window - 1, maxBytes);
    if (head) {
        const r = scanText(head.buf.toString("latin1"));
        workflow ??= r.workflow; prompt ??= r.prompt;
    }
    if ((!workflow || !prompt) && !(head?.full)) {
        const tail = await fetchTail(url, window, maxBytes);
        if (tail) {
            const r = scanText(tail.toString("latin1"));
            workflow ??= r.workflow; prompt ??= r.prompt;
        }
    }
    if (!workflow && !prompt) return { ok: false, kind: "video" };
    return { ok: true, kind: "video", workflow, prompt };
}

async function fetchVideoMeta(url: string, maxBytes: number): Promise<WorkflowMeta> {
    // sniff container by magic: EBML (1A 45 DF A3) = Matroska/WebM, else assume MP4/MOV
    const probe = await fetchRange(url, 0, 15, maxBytes);
    const b = probe?.buf;
    const isEbml = !!b && b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    return isEbml ? fetchMatroskaMeta(url, maxBytes) : fetchMp4Meta(url, maxBytes);
}

/* --------------------------------- API ------------------------------------ */

export async function fetchWorkflow(
    _: IpcMainInvokeEvent,
    url: string,
    maxBytes: number,
    kind: "png" | "webp" | "video" | "json" | "auto"
): Promise<WorkflowMeta> {
    try {
        if (kind === "video") return await fetchVideoMeta(url, maxBytes);

        if (kind === "json") {
            const jres = await fetch(url);
            if (!jres.ok) return { ok: false, kind: "json", error: `HTTP ${jres.status}` };
            const jlen = Number(jres.headers.get("content-length") ?? 0);
            if (maxBytes && jlen && jlen > maxBytes) return { ok: false, kind: "json", error: "too large" };
            const text = await jres.text(); // UTF-8 (preserves non-ASCII node titles)
            if (maxBytes && text.length > maxBytes) return { ok: false, kind: "json", error: "too large" };
            const r = scanText(text); // classifies by signature: last_node_id→workflow, class_type→prompt
            if (!r.workflow && !r.prompt) return { ok: false, kind: "json" };
            return { ok: true, kind: "json", workflow: r.workflow, prompt: r.prompt };
        }

        const res = await fetch(url);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const declared = Number(res.headers.get("content-length") ?? 0);
        if (maxBytes && declared && declared > maxBytes) return { ok: false, error: "too large" };
        const ab = await res.arrayBuffer();
        if (maxBytes && ab.byteLength > maxBytes) return { ok: false, error: "too large" };
        const buf = Buffer.from(ab);

        // sniff magic so a mislabelled extension still works
        const isPng = PNG_SIG.every((b, i) => buf[i] === b);
        const isWebp = buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";

        let res2: { workflow?: string; prompt?: string; } = {};
        let detected: WorkflowMeta["kind"] = "unknown";
        if (isPng) { res2 = parsePng(buf); detected = "png"; }
        else if (isWebp) { res2 = parseWebp(buf); detected = "webp"; }

        if (!res2.workflow && !res2.prompt) {
            res2 = scanText(buf.toString("latin1")); // generic fallback
        }
        if (!res2.workflow && !res2.prompt) return { ok: false, kind: detected };
        return { ok: true, kind: detected, workflow: res2.workflow, prompt: res2.prompt };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

export async function queuePrompt(
    _: IpcMainInvokeEvent,
    endpoint: string,
    promptJson: string,
    clientId: string
): Promise<{ ok: boolean; status: number; data: string; }> {
    try {
        const base = endpoint.replace(/\/+$/, "");
        const prompt = JSON.parse(promptJson);
        const res = await fetch(`${base}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt, client_id: clientId })
        });
        const data = await res.text();
        return { ok: res.ok, status: res.status, data };
    } catch (e) {
        return { ok: false, status: -1, data: String(e) };
    }
}

/** Compare the workflow's node types against what a server has (/object_info). */
export async function getMissingNodes(
    _: IpcMainInvokeEvent,
    endpoint: string,
    promptJson: string
): Promise<{ ok: boolean; missing?: string[]; total?: number; error?: string; }> {
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

/** Fetch raw bytes (base64) — used to make a local thumbnail that survives post deletion. */
export async function fetchBytes(
    _: IpcMainInvokeEvent,
    url: string,
    maxBytes: number
): Promise<{ ok: boolean; base64?: string; error?: string; }> {
    try {
        const res = await fetch(url);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const len = Number(res.headers.get("content-length") ?? 0);
        if (maxBytes && len && len > maxBytes) return { ok: false, error: "too large" };
        const ab = await res.arrayBuffer();
        if (maxBytes && ab.byteLength > maxBytes) return { ok: false, error: "too large" };
        return { ok: true, base64: Buffer.from(ab).toString("base64") };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}
