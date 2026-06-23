/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Drop inbox — a small bottom-right overlay that surfaces images arriving in the configured
 * "drop" channel (where the companion's webhook posts), each with a one-click Repost, so you
 * never have to open that channel. Fed by the MESSAGE_CREATE flux handler in index.tsx and
 * mounted once at plugin start.
 */

import { createRoot, React, useEffect, useState } from "@webpack/common";

import { NodeIcon } from "./icons";
import { openRepostPicker } from "./repost";
import { logger } from "./utils";

export interface DropItem { id: string; url: string; filename: string; isVideo: boolean; }

const MAX = 6;
let items: DropItem[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach(cb => cb());

/** Add an arriving image to the inbox (deduped, newest first, capped). */
export function addDropItem(item: DropItem) {
    if (items.some(i => i.id === item.id)) return;
    items = [item, ...items].slice(0, MAX);
    emit();
}
const dismiss = (id: string) => { items = items.filter(i => i.id !== id); emit(); };
const clearAll = () => { items = []; emit(); };

function DropInbox() {
    const [, force] = useState(0);
    useEffect(() => {
        const cb = () => force(n => n + 1);
        subs.add(cb);
        return () => { subs.delete(cb); };
    }, []);
    if (!items.length) return null;
    return (
        <div className="cwg-drop">
            <div className="cwg-drop-head">
                <span className="cwg-drop-title"><NodeIcon size={14} /> New from ComfyUI</span>
                <button className="cwg-drop-clear" title="Dismiss all" onClick={clearAll}>✕</button>
            </div>
            {items.map(it => (
                <div className="cwg-drop-item" key={it.id}>
                    <div className="cwg-drop-thumb">
                        {it.isVideo ? <video src={it.url} muted /> : <img src={it.url} alt="" />}
                    </div>
                    <div className="cwg-drop-meta" title={it.filename}>{it.filename}</div>
                    <button className="cwg-drop-repost" onClick={() => { openRepostPicker(it.url, it.filename); dismiss(it.id); }}>↪ Repost</button>
                    <button className="cwg-drop-x" title="Dismiss" onClick={() => dismiss(it.id)}>✕</button>
                </div>
            ))}
        </div>
    );
}

let host: HTMLDivElement | null = null;
let root: { render(node: React.ReactNode): void; unmount(): void; } | null = null;

export function mountDropInbox() {
    if (host) return;
    try {
        host = document.createElement("div");
        host.className = "cwg-drop-host";
        document.body.appendChild(host);
        root = createRoot(host);
        root.render(<DropInbox />);
    } catch (e) {
        logger.error("drop inbox mount failed", e);
    }
}

export function unmountDropInbox() {
    try { root?.unmount(); } catch { /* already gone */ }
    host?.remove();
    root = null; host = null; items = []; subs.clear();
}
