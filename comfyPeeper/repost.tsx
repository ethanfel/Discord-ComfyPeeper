/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Repost a Discord image/video to another server or channel as a fresh message — posted
 * as you, no "Forwarded" tag, with the workflow still embedded (we re-upload the original
 * bytes, which Discord keeps for image attachments). Right-click an image → "Repost to…"
 * → a favourite channel (from settings) or one you search for.
 *
 * Uploads via CloudUpload(targetChannelId) + RestAPI POST to that channel — the same
 * primitives uploadHook.tsx and the built-in voiceMessages plugin use.
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { CloudUpload as TCloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { ChannelStore, Constants, GuildChannelStore, GuildStore, Menu, Modal, openModal, PermissionsBits, PermissionStore, React, RestAPI, showToast, SnowflakeUtils, Toasts, useState } from "@webpack/common";

import { NodeIcon } from "./icons";
import { settings } from "./settings";
import { kindOf, logger, Native } from "./utils";

const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

interface Media { url: string; filename: string; }
interface Target { id: string; label: string; guildId?: string; }

const extOf = (name: string) => (/\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(name)?.[1] || "png").toLowerCase();
function mimeOf(name: string): string {
    switch (extOf(name)) {
        case "webp": return "image/webp";
        case "jpg": case "jpeg": return "image/jpeg";
        case "gif": return "image/gif";
        case "mp4": case "m4v": return "video/mp4";
        case "webm": return "video/webm";
        case "mov": return "video/quicktime";
        default: return "image/png";
    }
}
function filenameFromUrl(url: string): string {
    try { const n = new URL(url).pathname.split("/").pop(); if (n) return decodeURIComponent(n); } catch { /* not a URL */ }
    return "image.png";
}
export const channelIdOf = (s: string) => (/channels\/\d+\/(\d+)/.exec(s) ?? /(?:^|\D)(\d{17,21})(?:\D|$)/.exec(s))?.[1];

/** Parse the favourites setting into {id,label} targets, resolving channel names where possible. */
export function parseRepostTargets(raw: string): Target[] {
    return (raw || "").split(/[\n,]/).map(s => s.trim()).filter(Boolean).map(s => {
        const eq = s.indexOf("=");
        const id = channelIdOf(eq >= 0 ? s.slice(eq + 1) : s);
        if (!id) return null;
        const name = (eq >= 0 ? s.slice(0, eq).trim() : "") || ChannelStore.getChannel(id)?.name;
        return { id, label: name ? (name.startsWith("#") ? name : "#" + name) : id };
    }).filter((t): t is Target => !!t);
}

async function fetchFile(media: Media): Promise<File | null> {
    const r = await Native.fetchBytes(media.url, 100 * 1024 * 1024).catch(() => null);
    if (!r?.ok || !r.base64) return null;
    const bin = atob(r.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], media.filename, { type: mimeOf(media.filename) });
}

/** Re-upload the media to a target channel as a fresh message. */
export async function repost(channelId: string, label: string, media: Media) {
    showToast(`Reposting to ${label}…`, Toasts.Type.MESSAGE);
    const file = await fetchFile(media);
    if (!file) { showToast("Couldn't fetch that image", Toasts.Type.FAILURE); return; }
    try {
        const upload = new CloudUpload({ file, isThumbnail: false, platform: CloudUploadPlatform.WEB }, channelId);
        upload.on("complete", () => {
            RestAPI.post({
                url: Constants.Endpoints.MESSAGES(channelId),
                body: {
                    channel_id: channelId,
                    content: "",
                    nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                    sticker_ids: [],
                    type: 0,
                    attachments: [{ id: "0", filename: upload.filename, uploaded_filename: upload.uploadedFilename }]
                }
            }).then(
                () => showToast(`Reposted to ${label} ✓`, Toasts.Type.SUCCESS),
                (e: any) => showToast(`${label} rejected it (${e?.status || "error"})`, Toasts.Type.FAILURE)
            );
        });
        upload.on("error", () => showToast("Upload failed", Toasts.Type.FAILURE));
        upload.upload();
    } catch (e) {
        logger.error("repost failed", e);
        showToast("Repost failed", Toasts.Type.FAILURE);
    }
}

/* ------------------------------ channel picker ------------------------------ */

function sendableChannels(): Target[] {
    const out: Target[] = [];
    try {
        for (const g of Object.values<any>(GuildStore.getGuilds())) {
            for (const entry of (GuildChannelStore.getChannels(g.id)?.SELECTABLE ?? [])) {
                const ch = entry.channel;
                if (!ch || (ch.type !== 0 && ch.type !== 5)) continue; // text + announcement only
                if (!PermissionStore.can(PermissionsBits.SEND_MESSAGES, ch)) continue;
                out.push({ id: ch.id, label: `${g.name} / #${ch.name}`, guildId: g.id });
            }
        }
    } catch (e) { logger.warn("channel list failed", e); }
    return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** Add/remove a channel from the favourites setting (stored as a channel link). */
function toggleFavorite(t: Target) {
    const entries = (settings.store.repostTargets || "").split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    const has = entries.some(e => channelIdOf(e) === t.id);
    const next = has
        ? entries.filter(e => channelIdOf(e) !== t.id)
        : [...entries, t.guildId ? `https://discord.com/channels/${t.guildId}/${t.id}` : t.id];
    settings.store.repostTargets = next.join(", ");
}

function RepostPicker({ rootProps, media }: { rootProps: any; media: Media; }) {
    const [q, setQ] = useState("");
    const [favTick, setFavTick] = useState(0);
    const favIds = React.useMemo(() => new Set(parseRepostTargets(settings.store.repostTargets || "").map(t => t.id)), [favTick]);
    const all = React.useMemo(sendableChannels, []);
    const query = q.trim().toLowerCase();
    const visible = (query ? all.filter(t => t.label.toLowerCase().includes(query)) : all)
        .slice() // favourites first, then the existing alphabetical order
        .sort((a, b) => (favIds.has(b.id) ? 1 : 0) - (favIds.has(a.id) ? 1 : 0))
        .slice(0, 300);
    const toggle = (t: Target, e: any) => { e.stopPropagation(); toggleFavorite(t); setFavTick(n => n + 1); };
    return (
        <Modal {...rootProps} size="md" title={
            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexGrow: 1 }}><NodeIcon size={18} />Repost to…</span>
        }>
            <div className="cwg-assoc-search">
                <input type="text" value={q} autoFocus placeholder="Search servers / channels…" onChange={e => setQ(e.currentTarget.value)} />
            </div>
            <div className="cwg-assoc-list">
                {visible.length === 0
                    ? <div className="cwg-lib-empty">No channels you can post to.</div>
                    : visible.map(t => {
                        const fav = favIds.has(t.id);
                        return (
                            <div className="cwg-assoc-row" key={t.id} onClick={() => { rootProps.onClose(); repost(t.id, t.label, media); }}>
                                <button className={"cwg-fav-star" + (fav ? " on" : "")} title={fav ? "Remove from favourites" : "Add to favourites"} onClick={e => toggle(t, e)}>{fav ? "★" : "☆"}</button>
                                <div className="cwg-assoc-meta"><div className="cwg-assoc-title" title={t.label}>{t.label}</div></div>
                            </div>
                        );
                    })}
            </div>
        </Modal>
    );
}

/* ------------------------------- menu wiring ------------------------------- */

/** Open the repost picker for a media url (used by the right-click menu and the drop inbox). */
export const openRepostPicker = (url: string, filename?: string) =>
    openModal(rp => <RepostPicker rootProps={rp} media={{ url, filename: filename || filenameFromUrl(url) }} />);

const isMedia = (a: any) => { const k = kindOf(a); return k === "png" || k === "webp" || k === "video"; };

// Flat "Repost to…" items that open the picker directly (favourites are pinned at its top).
// Nested submenus mis-position to the screen corner near the bottom of the menu, so we avoid them.
export const imageRepostContextPatch: NavContextMenuPatchCallback = (children, props) => {
    const src: string | undefined = props?.src;
    if (src) children.push(<Menu.MenuItem key="cwg-repost-img" id="cwg-repost-img" label="Repost to…" action={() => openRepostPicker(src)} />);
};

export const messageRepostContextPatch: NavContextMenuPatchCallback = (children, props) => {
    const atts: any[] = (props?.message?.attachments ?? []).filter(isMedia);
    if (atts.length === 1)
        children.push(<Menu.MenuItem key="cwg-repost-msg" id="cwg-repost-msg" label="Repost to…" action={() => openRepostPicker(atts[0].url, atts[0].filename)} />);
    else
        for (const a of atts)
            children.push(<Menu.MenuItem key={"cwg-repost-att-" + a.id} id={"cwg-repost-att-" + a.id} label={`Repost ${a.filename || "image"}…`} action={() => openRepostPicker(a.url, a.filename)} />);
};

/** Right-click a channel → toggle it as a repost favourite. */
export const channelRepostFavPatch: NavContextMenuPatchCallback = (children, props) => {
    const ch = props?.channel;
    if (!ch || (ch.type !== 0 && ch.type !== 5)) return; // text + announcement only
    if (!PermissionStore.can(PermissionsBits.SEND_MESSAGES, ch)) return;
    const isFav = parseRepostTargets(settings.store.repostTargets || "").some(t => t.id === ch.id);
    children.push(
        <Menu.MenuItem
            key="cwg-repost-fav-toggle"
            id="cwg-repost-fav-toggle"
            label={isFav ? "Remove from ComfyPeeper favourites" : "Add to ComfyPeeper favourites"}
            action={() => {
                toggleFavorite({ id: ch.id, label: "#" + (ch.name || ch.id), guildId: ch.guild_id });
                showToast(isFav ? "Removed from repost favourites" : "Added to repost favourites ★", Toasts.Type.SUCCESS);
            }}
        />
    );
};
