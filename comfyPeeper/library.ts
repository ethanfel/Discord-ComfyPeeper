/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { downloadJson, logger, Native, playYoink } from "./utils";

/** A workflow saved to the local library — survives even if the original post is deleted. */
export interface SavedWf {
    id: string;
    savedAt: number;
    title: string;
    kind: string;
    workflow?: string;
    prompt?: string;
    thumb?: string; // small data URL, stored locally so it survives deletion
    sourceUrl?: string; // original CDN url (expires when the message is deleted)
    messageLink?: string; // discord jump link to the original post
    channelId?: string; // channel it was collected from
    channelName?: string; // pretty channel name for grouping (e.g. "#art")
    mediaIsVideo?: boolean; // a manually-associated media is a video (thumb is a captured frame)
}

export interface SaveSource {
    id?: string; // when re-opening a saved entry, reuse its id (avoids duplicates)
    messageId?: string;
    messageLink?: string;
    sourceUrl?: string;
    isImage?: boolean;
    channelId?: string;
    channelName?: string;
}

const KEY = "ComfyPeeper_library";
const THUMB_MAX = 320;
const THUMB_MAX_BYTES = 50_000; // keep stored previews small

export async function getLibrary(): Promise<SavedWf[]> {
    return (await DataStore.get<SavedWf[]>(KEY)) ?? [];
}

// A synchronous snapshot of the library, so the right-click menu can list recent entries
// without awaiting. Warmed on plugin start and refreshed after every mutation.
let cache: SavedWf[] | null = null;
export async function warmLibraryCache(): Promise<void> { cache = await getLibrary(); }
const refreshCache = () => warmLibraryCache().catch(e => logger.warn("cache refresh failed", e));
/** The n most recently saved entries (sync, from cache) — for the associate submenu. */
export function recentEntries(n = 3): SavedWf[] {
    return [...(cache ?? [])].sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0)).slice(0, n);
}

export async function hasEntry(id: string): Promise<boolean> {
    return (await getLibrary()).some(e => e.id === id);
}

export async function addEntry(entry: SavedWf): Promise<void> {
    await DataStore.update<SavedWf[]>(KEY, (lib = []) => [entry, ...lib.filter(e => e.id !== entry.id)]);
    void refreshCache();
}

/* ---- export / import (move the library between desktop and browser) ---- */

interface LibraryExport { app: "ComfyPeeper"; type: "library-export"; version: number; exportedAt: number; count: number; entries: SavedWf[]; }
export type ConflictResolve = "newest" | "existing" | "imported";

/** Download the whole library as one .json (also a handy backup). Returns the entry count. */
export async function exportLibrary(): Promise<number> {
    const entries = await getLibrary();
    const payload: LibraryExport = { app: "ComfyPeeper", type: "library-export", version: 1, exportedAt: Date.now(), count: entries.length, entries };
    const stamp = new Date().toISOString().slice(0, 10);
    downloadJson(`comfypeeper-library-${stamp}.json`, JSON.stringify(payload, null, 2));
    return entries.length;
}

/** Parse an exported file into entries (accepts the wrapper object or a bare array). Throws if it isn't one. */
export function parseLibraryFile(text: string): SavedWf[] {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : (Array.isArray(data?.entries) ? data.entries : null);
    if (!arr) throw new Error("not a ComfyPeeper library export");
    return arr
        .filter((e: any) => e && typeof e.id === "string" && (e.workflow || e.prompt))
        .map((e: any) => ({ ...e, savedAt: Number(e.savedAt) || Date.now() }) as SavedWf);
}

/** How many incoming entries collide (same id) with what's already saved. */
export async function countConflicts(incoming: SavedWf[]): Promise<number> {
    const ids = new Set((await getLibrary()).map(e => e.id));
    return incoming.reduce((n, e) => n + (ids.has(e.id) ? 1 : 0), 0);
}

/** Merge entries in, resolving same-id conflicts per the chosen strategy. */
export async function importLibrary(incoming: SavedWf[], resolve: ConflictResolve): Promise<{ added: number; updated: number; skipped: number; }> {
    let added = 0, updated = 0, skipped = 0;
    await DataStore.update<SavedWf[]>(KEY, (lib = []) => {
        const byId = new Map(lib.map(e => [e.id, e]));
        for (const e of incoming) {
            const cur = byId.get(e.id);
            if (!cur) { byId.set(e.id, e); added++; }
            else if (resolve === "existing") skipped++;
            else if (resolve === "imported") { byId.set(e.id, e); updated++; }
            else if ((e.savedAt ?? 0) > (cur.savedAt ?? 0)) { byId.set(e.id, e); updated++; } // "newest"
            else skipped++;
        }
        return [...byId.values()].sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
    });
    void refreshCache();
    return { added, updated, skipped };
}

export async function removeEntry(id: string): Promise<void> {
    await DataStore.update<SavedWf[]>(KEY, (lib = []) => lib.filter(e => e.id !== id));
    void refreshCache();
}

/** Attach a (manually chosen) image/video to an existing entry as its preview + source link. */
export async function setEntryMedia(id: string, media: { thumb?: string; sourceUrl?: string; isVideo?: boolean; }): Promise<void> {
    await DataStore.update<SavedWf[]>(KEY, (lib = []) => lib.map(e => e.id === id
        ? { ...e, thumb: media.thumb ?? e.thumb, sourceUrl: media.sourceUrl ?? e.sourceUrl, mediaIsVideo: media.isVideo ?? e.mediaIsVideo }
        : e));
    void refreshCache();
}

export function entryId(att: any, source?: SaveSource): string {
    if (source?.id) return source.id;
    return `${source?.messageId ?? "x"}:${att?.id ?? "x"}:${att?.filename ?? ""}`;
}

const dataUrlBytes = (u: string) => Math.floor((u.length - (u.indexOf(",") + 1)) * 3 / 4); // ≈ decoded size

/** A canvas scaled so its longest side is THUMB_MAX; returns null if no 2D context. */
function scaledCanvas(srcW: number, srcH: number) {
    const scale = Math.min(1, THUMB_MAX / Math.max(srcW || 1, srcH || 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((srcW || 1) * scale));
    canvas.height = Math.max(1, Math.round((srcH || 1) * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#0b0d10"; // opaque bg so the JPEG fallback (no alpha) doesn't show transparency as black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return { canvas, ctx, w: canvas.width, h: canvas.height };
}

/**
 * Encode a canvas to a compact data URL, stepping quality down to fit the size budget.
 * Prefers WebP, but Firefox's toDataURL ignores image/webp and returns a huge lossless
 * PNG — detect that and fall back to JPEG, which honours the quality param.
 */
function compactThumb(canvas: HTMLCanvasElement): string {
    let url = canvas.toDataURL("image/webp", 0.72);
    const fmt = url.startsWith("data:image/webp") ? "image/webp" : "image/jpeg";
    if (fmt === "image/jpeg") url = canvas.toDataURL("image/jpeg", 0.72);
    for (const q of [0.55, 0.4, 0.3, 0.22]) {
        if (dataUrlBytes(url) <= THUMB_MAX_BYTES) break;
        url = canvas.toDataURL(fmt, q);
    }
    return url;
}

/** Fetch the image (via native, no CORS) and downscale to a small data URL. */
async function makeImageThumb(url: string): Promise<string | undefined> {
    try {
        const r = await Native.fetchBytes(url, 30 * 1024 * 1024);
        if (!r.ok || !r.base64) return undefined;
        const bin = atob(r.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([bytes]));
        const sc = scaledCanvas(bmp.width, bmp.height);
        if (!sc) { bmp.close?.(); return undefined; }
        sc.ctx.drawImage(bmp, 0, 0, sc.w, sc.h);
        bmp.close?.();
        return compactThumb(sc.canvas);
    } catch (e) {
        logger.warn("thumbnail failed", e);
        return undefined;
    }
}

const VIDEO_THUMB_MAX_BYTES = 60 * 1024 * 1024; // skip a thumbnail for very large videos (still links them)

/** Capture a frame (~0.1s in) from a same-origin (blob:) video and downscale it. */
function captureVideoFrame(src: string): Promise<string | undefined> {
    return new Promise(resolve => {
        let done = false;
        const video = document.createElement("video");
        const finish = (v?: string) => {
            if (done) return; done = true;
            clearTimeout(timer);
            try { video.removeAttribute("src"); video.load(); } catch { /* ignore */ }
            resolve(v);
        };
        const timer = setTimeout(() => finish(undefined), 15_000);
        video.muted = true;
        video.preload = "auto";
        (video as any).playsInline = true;
        video.addEventListener("error", () => finish(undefined), { once: true });
        video.addEventListener("loadeddata", () => {
            try { video.currentTime = Math.min(0.1, (isFinite(video.duration) ? video.duration : 1) * 0.1); }
            catch { finish(undefined); }
        }, { once: true });
        video.addEventListener("seeked", () => {
            try {
                const sc = scaledCanvas(video.videoWidth, video.videoHeight);
                if (!sc) return finish(undefined);
                sc.ctx.drawImage(video, 0, 0, sc.w, sc.h);
                finish(compactThumb(sc.canvas));
            } catch (e) { logger.warn("video frame failed", e); finish(undefined); }
        }, { once: true });
        video.src = src; // blob: URL → same-origin → canvas isn't tainted
    });
}

/*
 * Grab a small frame from a video. Cross-origin CDN <video> drawn to a canvas taints it
 * (Firefox especially), so toDataURL throws — instead download the bytes via our GM/native
 * fetch (bypasses CORS) and play them from a blob: URL (same-origin, untainted). Only the
 * tiny captured frame is kept; the video itself is never stored.
 */
async function makeVideoThumb(url: string): Promise<string | undefined> {
    let objectUrl: string | undefined;
    try {
        const r = await Native.fetchBytes(url, VIDEO_THUMB_MAX_BYTES);
        if (!r.ok || !r.base64) return undefined;
        const bin = atob(r.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        objectUrl = URL.createObjectURL(new Blob([bytes]));
        return await captureVideoFrame(objectUrl);
    } catch (e) {
        logger.warn("video thumb failed", e);
        return undefined;
    } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
}

/** Make a compact preview for any media kind (returns undefined on failure — caller still links it). */
export function makeMediaThumb(url: string, isVideo: boolean): Promise<string | undefined> {
    return isVideo ? makeVideoThumb(url) : makeImageThumb(url);
}

export async function saveToLibrary(
    att: any,
    meta: { workflow?: string; prompt?: string; kind?: string; },
    source?: SaveSource
): Promise<SavedWf> {
    const thumb = source?.isImage && source.sourceUrl ? await makeImageThumb(source.sourceUrl) : undefined;
    const entry: SavedWf = {
        id: entryId(att, source),
        savedAt: Date.now(),
        title: att?.filename || "workflow",
        kind: meta.kind || "unknown",
        workflow: meta.workflow,
        prompt: meta.prompt,
        thumb,
        sourceUrl: source?.sourceUrl,
        messageLink: source?.messageLink,
        channelId: source?.channelId,
        channelName: source?.channelName
    };
    await addEntry(entry);
    playYoink();
    return entry;
}
