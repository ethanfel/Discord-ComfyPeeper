/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { downloadJson, logger, Native } from "./utils";

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

export async function getLibrary(): Promise<SavedWf[]> {
    return (await DataStore.get<SavedWf[]>(KEY)) ?? [];
}

export async function hasEntry(id: string): Promise<boolean> {
    return (await getLibrary()).some(e => e.id === id);
}

export async function addEntry(entry: SavedWf): Promise<void> {
    await DataStore.update<SavedWf[]>(KEY, (lib = []) => [entry, ...lib.filter(e => e.id !== entry.id)]);
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
    return { added, updated, skipped };
}

export async function removeEntry(id: string): Promise<void> {
    await DataStore.update<SavedWf[]>(KEY, (lib = []) => lib.filter(e => e.id !== id));
}

export function entryId(att: any, source?: SaveSource): string {
    if (source?.id) return source.id;
    return `${source?.messageId ?? "x"}:${att?.id ?? "x"}:${att?.filename ?? ""}`;
}

/** Fetch the image (via native, no CORS) and downscale to a small data URL. */
async function makeThumb(url: string): Promise<string | undefined> {
    try {
        const r = await Native.fetchBytes(url, 30 * 1024 * 1024);
        if (!r.ok || !r.base64) return undefined;
        const bin = atob(r.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([bytes]));
        const scale = Math.min(1, THUMB_MAX / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return undefined;
        ctx.drawImage(bmp, 0, 0, w, h);
        bmp.close?.();
        return canvas.toDataURL("image/webp", 0.7);
    } catch (e) {
        logger.warn("thumbnail failed", e);
        return undefined;
    }
}

export async function saveToLibrary(
    att: any,
    meta: { workflow?: string; prompt?: string; kind?: string; },
    source?: SaveSource
): Promise<SavedWf> {
    const thumb = source?.isImage && source.sourceUrl ? await makeThumb(source.sourceUrl) : undefined;
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
    return entry;
}
