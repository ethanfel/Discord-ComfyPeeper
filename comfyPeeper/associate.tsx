/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Manually associate a Discord image/video with a saved workflow.
 *
 * Auto-pairing only links a video to the .json sidecars uploaded alongside it. When the
 * media and its workflow are posted separately (or by hand), nothing links them — so this
 * adds a right-click "Associate with workflow" action (on images via "image-context", and
 * on any message's media via "message") that attaches the media as a library entry's
 * preview + source link. Lists the last 3 saved workflows, plus a "Search library…" picker.
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Alerts, Menu, Modal, openModal, React, showToast, Toasts, useEffect, useState } from "@webpack/common";

import { NodeIcon } from "./icons";
import { getLibrary, makeMediaThumb, recentEntries, SavedWf, setEntryMedia } from "./library";
import { kindOf } from "./utils";

interface Media { url: string; isVideo: boolean; filename?: string; }

const truncate = (s: string, n = 42) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const isMedia = (a: any) => { const k = kindOf(a); return k === "png" || k === "webp" || k === "video"; };
const mediaOf = (a: any): Media => ({ url: a.url, isVideo: kindOf(a) === "video", filename: a.filename });

async function doAssociate(entry: SavedWf, media: Media) {
    showToast(`Linking media to “${truncate(entry.title)}”…`, Toasts.Type.MESSAGE);
    const thumb = await makeMediaThumb(media.url, media.isVideo);
    await setEntryMedia(entry.id, { thumb, sourceUrl: media.url, isVideo: media.isVideo });
    showToast(thumb ? `Linked ✓ — “${truncate(entry.title)}”` : `Linked (preview unavailable) — “${truncate(entry.title)}”`,
        thumb ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE);
}

/** Associate, warning first if the target already has a preview. */
function associate(entry: SavedWf, media: Media) {
    if (entry.thumb) {
        Alerts.show({
            title: "Replace preview?",
            body: `“${truncate(entry.title)}” already has a preview. Replace it with this ${media.isVideo ? "video frame" : "image"}?`,
            confirmText: "Replace",
            cancelText: "Cancel",
            onConfirm: () => void doAssociate(entry, media)
        });
    } else {
        void doAssociate(entry, media);
    }
}

/* --------------------------- "Search library…" picker --------------------------- */

function AssociatePicker({ rootProps, media }: { rootProps: any; media: Media; }) {
    const [items, setItems] = useState<SavedWf[] | null>(null);
    const [query, setQuery] = useState("");
    useEffect(() => { getLibrary().then(setItems); }, []);

    const q = query.trim().toLowerCase();
    const visible = (items ?? []).filter(e => !q || `${e.title}\n${e.channelName ?? ""}`.toLowerCase().includes(q));

    return (
        <Modal {...rootProps} size="md" title={
            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexGrow: 1 }}>
                <NodeIcon size={18} />Associate {media.isVideo ? "video" : "image"} with…
            </span>
        }>
            <div className="cwg-assoc-search">
                <input type="text" value={query} autoFocus placeholder="Search saved workflows…" onChange={e => setQuery(e.currentTarget.value)} />
            </div>
            <div className="cwg-assoc-list">
                {items === null
                    ? <div className="cwg-lib-empty">Loading…</div>
                    : visible.length === 0
                        ? <div className="cwg-lib-empty">No saved workflows{q ? " match" : " yet"}.</div>
                        : visible.map(e => (
                            <div className="cwg-assoc-row" key={e.id} onClick={() => { rootProps.onClose(); associate(e, media); }}>
                                <div className="cwg-assoc-thumb">{e.thumb ? <img src={e.thumb} alt="" /> : <NodeIcon size={20} />}</div>
                                <div className="cwg-assoc-meta">
                                    <div className="cwg-assoc-title" title={e.title}>{e.title}</div>
                                    {e.channelName && <div className="cwg-assoc-sub">{e.channelName}</div>}
                                </div>
                                {e.thumb && <span className="cwg-assoc-has" title="Already has a preview — picking will ask to replace">has preview</span>}
                            </div>
                        ))}
            </div>
        </Modal>
    );
}

/* ------------------------------- menu construction ------------------------------- */

/** The submenu body: last 3 saved workflows + a search escape hatch. */
function targetItems(media: Media) {
    const recents = recentEntries(3);
    const items = recents.map(e => (
        <Menu.MenuItem
            key={"cwg-assoc-" + e.id}
            id={"cwg-assoc-" + e.id}
            label={(e.thumb ? "⚠ " : "") + truncate(e.title)}
            action={() => associate(e, media)}
        />
    ));
    if (!recents.length)
        items.push(<Menu.MenuItem key="cwg-assoc-none" id="cwg-assoc-none" label="No saved workflows yet" disabled />);
    items.push(<Menu.MenuSeparator key="cwg-assoc-sep" />);
    items.push(
        <Menu.MenuItem
            key="cwg-assoc-search"
            id="cwg-assoc-search"
            label="Search library…"
            action={() => openModal(rp => <AssociatePicker rootProps={rp} media={media} />)}
        />
    );
    return items;
}

const associateSubmenu = (media: Media, key: string) => (
    <Menu.MenuItem key={key} id={key} label="Associate with workflow">
        {targetItems(media)}
    </Menu.MenuItem>
);

/** Right-click an image → its dedicated menu exposes the URL as props.src. */
export const imageAssociateContextPatch: NavContextMenuPatchCallback = (children, props) => {
    const src: string | undefined = props?.src;
    if (!src) return;
    children.push(<Menu.MenuSeparator key="cwg-assoc-sep0" />, associateSubmenu({ url: src, isVideo: false }, "cwg-associate-img"));
};

/** Right-click a message → use its media attachments (covers videos too). */
export const messageAssociateContextPatch: NavContextMenuPatchCallback = (children, props) => {
    const atts: any[] = (props?.message?.attachments ?? []).filter(isMedia);
    if (!atts.length) return;

    const item = atts.length === 1
        ? associateSubmenu(mediaOf(atts[0]), "cwg-associate-msg")
        : (
            <Menu.MenuItem key="cwg-associate-msg" id="cwg-associate-msg" label="Associate media with workflow">
                {atts.map(a => (
                    <Menu.MenuItem key={"cwg-assoc-att-" + a.id} id={"cwg-assoc-att-" + a.id} label={truncate(a.filename || "attachment")}>
                        {targetItems(mediaOf(a))}
                    </Menu.MenuItem>
                ))}
            </Menu.MenuItem>
        );
    children.push(<Menu.MenuSeparator key="cwg-assoc-sep0" />, item);
};
