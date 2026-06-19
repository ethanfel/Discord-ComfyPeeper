/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button, Modal, NavigationRouter, openModal, React, useEffect, useState } from "@webpack/common";

import { NodeIcon } from "./icons";
import { getLibrary, removeEntry, SavedWf } from "./library";
import { openWorkflowModal } from "./WorkflowModal";

const S = {
    scroll: { overflowY: "auto", maxHeight: "66vh", padding: "4px 4px 4px 2px" } as const,
    section: { position: "relative", borderLeft: "2px solid #4b4f57", marginLeft: "6px", paddingLeft: "18px", paddingBottom: "14px" } as const,
    head: { display: "flex", alignItems: "center", gap: "8px", margin: "0 0 10px", fontSize: "13px", fontWeight: 700, color: "#e3e6eb" } as const,
    dot: { position: "absolute", left: "-7px", width: "12px", height: "12px", borderRadius: "50%", background: "#5865f2", border: "2px solid #1e1f22" } as const,
    count: { color: "#8a93a0", fontWeight: 400 } as const,
    grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "10px" } as const,
    card: { border: "1px solid #ffffff1f", borderRadius: "8px", overflow: "hidden", background: "#00000026", display: "flex", flexDirection: "column" } as const,
    thumb: { height: "116px", background: "#00000044", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", overflow: "hidden" } as const,
    img: { width: "100%", height: "100%", objectFit: "cover" } as const,
    noimg: { color: "#6f7787", display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", fontSize: "11px" } as const,
    title: { padding: "6px 8px 0", fontSize: "12px", fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const,
    meta: { padding: "0 8px 6px", fontSize: "11px", color: "#8a93a0" } as const,
    actions: { display: "flex", gap: "4px", padding: "0 8px 8px", marginTop: "auto", flexWrap: "wrap" } as const,
    empty: { padding: "28px", color: "#b9b9b9", fontStyle: "italic", textAlign: "center" } as const
};

function bucketLabel(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = 86_400_000;
    if (ts >= startOfToday) return "Today";
    if (ts >= startOfToday - day) return "Yesterday";
    if (ts >= startOfToday - 6 * day) return "Earlier this week";
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleString(undefined, { month: "long" });
    return d.toLocaleString(undefined, { month: "long", year: "numeric" });
}

function groupByDate(items: SavedWf[]): { label: string; items: SavedWf[]; }[] {
    const sorted = [...items].sort((a, b) => b.savedAt - a.savedAt);
    const out: { label: string; items: SavedWf[]; }[] = [];
    for (const it of sorted) {
        const label = bucketLabel(it.savedAt);
        const last = out[out.length - 1];
        if (last && last.label === label) last.items.push(it);
        else out.push({ label, items: [it] });
    }
    return out;
}

function openSaved(e: SavedWf) {
    const att = {
        id: e.id,
        filename: e.title,
        content_type: e.thumb ? "image/webp" : "application/json",
        url: e.thumb || e.sourceUrl // stored thumbnail survives deletion
    };
    openWorkflowModal(
        att,
        { ok: true, kind: e.kind as any, workflow: e.workflow, prompt: e.prompt },
        { id: e.id, messageLink: e.messageLink, sourceUrl: e.sourceUrl } // id keeps it deduped / marked saved
    );
}

function jump(link?: string) {
    if (!link) return;
    try { NavigationRouter.transitionTo(new URL(link).pathname); }
    catch { /* ignore bad link */ }
}

function Card({ e, onDelete, close }: { e: SavedWf; onDelete: () => void; close: () => void; }) {
    const open = () => { close(); openSaved(e); }; // replace, don't stack
    const post = () => { close(); jump(e.messageLink); };
    return (
        <div style={S.card}>
            <div style={S.thumb} onClick={open} title="Open preview">
                {e.thumb
                    ? <img style={S.img} src={e.thumb} alt={e.title} />
                    : <div style={S.noimg}><NodeIcon size={28} />{e.kind}</div>}
            </div>
            <div style={S.title} title={e.title}>{e.title}</div>
            <div style={S.meta}>{new Date(e.savedAt).toLocaleString()} · {e.kind}</div>
            <div style={S.actions}>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={open}>Open</Button>
                {e.messageLink && <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={post}>Post</Button>}
                <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} onClick={onDelete}>Delete</Button>
            </div>
        </div>
    );
}

function LibraryModal({ rootProps }: { rootProps: any; }) {
    const [items, setItems] = useState<SavedWf[] | null>(null);
    const reload = () => { getLibrary().then(setItems); };
    useEffect(reload, []);

    const groups = items ? groupByDate(items) : [];

    return (
        <Modal {...rootProps} size="lg" title={
            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexGrow: 1 }}>
                <NodeIcon size={18} />ComfyPeeper Library {items ? `(${items.length})` : ""}
            </span>
        }>
            {items === null
                ? <div style={S.empty}>Loading…</div>
                : items.length === 0
                    ? <div style={S.empty}>No saved workflows yet.<br />Open a workflow and hit <b>★ Save to library</b>.</div>
                    : <div className="cwg-selectable" style={S.scroll}>
                        {groups.map(g => (
                            <div key={g.label} style={S.section}>
                                <div style={S.head}><span style={S.dot} />{g.label} <span style={S.count}>· {g.items.length}</span></div>
                                <div style={S.grid}>
                                    {g.items.map(e => <Card key={e.id} e={e} close={rootProps.onClose} onDelete={() => removeEntry(e.id).then(reload)} />)}
                                </div>
                            </div>
                        ))}
                    </div>}
        </Modal>
    );
}

export function openLibraryModal() {
    openModal(rootProps => <LibraryModal rootProps={rootProps} />);
}
