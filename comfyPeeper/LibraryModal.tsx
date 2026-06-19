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
    grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "12px", overflowY: "auto", maxHeight: "66vh", padding: "4px" } as const,
    card: { border: "1px solid #ffffff1f", borderRadius: "8px", overflow: "hidden", background: "#00000026", display: "flex", flexDirection: "column" } as const,
    thumb: { height: "120px", background: "#00000044", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", overflow: "hidden" } as const,
    img: { width: "100%", height: "100%", objectFit: "cover" } as const,
    noimg: { color: "#6f7787", display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", fontSize: "11px" } as const,
    title: { padding: "6px 8px 0", fontSize: "12px", fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const,
    meta: { padding: "0 8px 6px", fontSize: "11px", color: "#8a93a0" } as const,
    actions: { display: "flex", gap: "4px", padding: "0 8px 8px", marginTop: "auto", flexWrap: "wrap" } as const,
    empty: { padding: "28px", color: "#b9b9b9", fontStyle: "italic", textAlign: "center" } as const
};

function openSaved(e: SavedWf) {
    const att = {
        id: e.id,
        filename: e.title,
        // use the stored thumbnail as the preview image so it survives deletion
        content_type: e.thumb ? "image/webp" : "application/json",
        url: e.thumb || e.sourceUrl
    };
    openWorkflowModal(
        att,
        { ok: true, kind: e.kind as any, workflow: e.workflow, prompt: e.prompt },
        { messageLink: e.messageLink, sourceUrl: e.sourceUrl }
    );
}

function jump(link?: string) {
    if (!link) return;
    try { NavigationRouter.transitionTo(new URL(link).pathname); }
    catch { /* ignore bad link */ }
}

function LibraryModal({ rootProps }: { rootProps: any; }) {
    const [items, setItems] = useState<SavedWf[] | null>(null);
    const reload = () => { getLibrary().then(setItems); };
    useEffect(reload, []);

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
                    : <div className="cwg-selectable" style={S.grid}>
                        {items.map(e => (
                            <div key={e.id} style={S.card}>
                                <div style={S.thumb} onClick={() => openSaved(e)} title="Open preview">
                                    {e.thumb
                                        ? <img style={S.img} src={e.thumb} alt={e.title} />
                                        : <div style={S.noimg}><NodeIcon size={28} />{e.kind}</div>}
                                </div>
                                <div style={S.title} title={e.title}>{e.title}</div>
                                <div style={S.meta}>{new Date(e.savedAt).toLocaleDateString()} · {e.kind}</div>
                                <div style={S.actions}>
                                    <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={() => openSaved(e)}>Open</Button>
                                    {e.messageLink && <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => jump(e.messageLink)}>Post</Button>}
                                    <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} onClick={() => removeEntry(e.id).then(reload)}>Delete</Button>
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
