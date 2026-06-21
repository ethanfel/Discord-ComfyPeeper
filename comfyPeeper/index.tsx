/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { Button, ChannelStore, React, ReactDOM, useEffect, useRef, useState } from "@webpack/common";

import { imageAssociateContextPatch, messageAssociateContextPatch } from "./associate";
import { NodeIcon } from "./icons";
import { SaveSource, warmLibraryCache } from "./library";
import { openLibraryModal } from "./LibraryModal";
import { settings } from "./settings";
import { onBeforeMessageSend } from "./uploadHook";
import { copyWithToast, downloadJson, findGraphInText, getMeta, hasMedia, Kind, kindOf, parseEndpoints, queue, WorkflowMeta } from "./utils";
import { openWorkflowModal } from "./WorkflowModal";

/** Find the rendered <img>/<video> in a message that corresponds to this attachment. */
function findMedia(scope: ParentNode, att: any): HTMLElement | null {
    const id = String(att.id);
    const name = att.filename ? String(att.filename) : "";
    const els = Array.from(scope.querySelectorAll("img, video")) as HTMLElement[];
    return els.find(el => {
        const src = (el as HTMLImageElement).src
            || (el as HTMLVideoElement).currentSrc
            || el.getAttribute("src")
            || el.getAttribute("poster")
            || el.querySelector("source")?.getAttribute("src")
            || "";
        return src.includes(`/${id}/`)
            || (name && (src.includes(encodeURIComponent(name)) || src.includes(name)));
    }) ?? null;
}

function BadgePill({ att, meta, compact, source }: { att: any; meta: WorkflowMeta; compact?: boolean; source?: SaveSource; }) {
    const endpoints = parseEndpoints(settings.store.endpoints);
    const json = meta.workflow ?? meta.prompt!;
    const baseName = (att.filename || "workflow").replace(/\.[^.]+$/, "");
    const n = meta.variants?.length ?? 0;
    const kindTag = n > 1 ? ` (${n} workflows)` : (meta.kind && meta.kind !== "png" ? ` (${meta.kind})` : "");

    return (
        <div className={"cwg-badge" + (compact ? " cwg-compact" : "")}>
            <span
                className="cwg-tag"
                role="button"
                title="Click to preview the ComfyUI workflow"
                onClick={() => openWorkflowModal(att, meta, source)}
            >
                <NodeIcon />{compact ? "ComfyUI" : "ComfyUI workflow"}{kindTag}
            </span>

            {!compact && <>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => copyWithToast(json, "Workflow JSON copied")}>Copy</Button>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => downloadJson(`${baseName}.json`, json)}>Save .json</Button>
                {meta.prompt && endpoints.map(ep => (
                    <Button key={ep.url} size={Button.Sizes.SMALL} color={Button.Colors.GREEN} onClick={() => queue(ep, meta.prompt!)}>
                        ▶ {endpoints.length > 1 ? `Queue → ${ep.label}` : "Queue"}
                    </Button>
                ))}
            </>}
        </div>
    );
}

function countNodes(m: { workflow?: string; prompt?: string; }): number {
    try {
        if (m.workflow) return JSON.parse(m.workflow).nodes?.length ?? 0;
        if (m.prompt) return Object.keys(JSON.parse(m.prompt)).length;
    } catch { /* ignore */ }
    return 0;
}

/** A stripped video lost its embedded graphs — rebuild the multi-workflow chain from the
 *  sidecars we attached at upload time (<base>.workflow.json, <base>.workflow2.json, …). */
async function metaFromSidecars(sidecars: any[], kind: Kind): Promise<WorkflowMeta | null> {
    const metas = await Promise.all(sidecars.map(s => getMeta(s, "json")));
    const variants = metas
        .filter(x => x.ok && (x.workflow || x.prompt))
        .map((x, i) => ({ label: `Workflow ${i + 1} · ${countNodes(x)} nodes`, workflow: x.workflow, prompt: x.prompt }));
    if (!variants.length) return null;
    const p = variants[0];
    return { ok: true, kind, workflow: p.workflow, prompt: p.prompt, variants: variants.length > 1 ? variants : undefined };
}

function WorkflowControls({ att, kind, source, metaAtts }: { att: any; kind: Kind; source?: SaveSource; metaAtts?: any[]; }) {
    const [meta, setMeta] = useState<WorkflowMeta | null>(null);
    const [busy, setBusy] = useState(false);
    const [host, setHost] = useState<HTMLElement | null>(null);
    const [overlayFailed, setOverlayFailed] = useState(false);
    const anchorRef = useRef<HTMLSpanElement>(null);

    const scan = () => {
        setBusy(true);
        // Prefer the media's OWN metadata (richer — may contain multiple workflows). If it was
        // stripped (e.g. Discord re-encoded the video) rebuild the chain from the .json sidecars.
        getMeta(att, kind)
            .then(m => (m.ok || !metaAtts?.length) ? m : metaFromSidecars(metaAtts, kind).then(s => s ?? m))
            .then(setMeta)
            .finally(() => setBusy(false));
    };

    useEffect(() => {
        if (settings.store.autoScan) scan();
    }, [att.id]);

    const mode = settings.store.badgeMode as "overlay" | "below" | "both";
    const canOverlay = hasMedia(kind); // json/audio have no image to attach to
    const wantOverlay = !!meta?.ok && canOverlay && (mode === "overlay" || mode === "both");

    // Attempt to attach an overlay host onto the rendered image's wrapper.
    useEffect(() => {
        if (!wantOverlay) return;
        let cancelled = false;
        let tries = 0;
        let container: HTMLElement | null = null;
        let timer: ReturnType<typeof setTimeout>;

        const run = () => {
            if (cancelled) return;
            const anchor = anchorRef.current;
            const scope = (anchor?.closest("li[id^='chat-messages-']")
                ?? anchor?.closest("[class*='message_']")
                ?? anchor?.closest("[class*='messageListItem']")) as HTMLElement | null;
            const media = findMedia(scope ?? document.body, att);
            if (!media) {
                if (tries++ < 40) { timer = setTimeout(run, 120); }
                else if (!cancelled) setOverlayFailed(true);
                return;
            }
            const wrapper = (media.closest("[class*='imageContainer']")
                ?? media.closest("[class*='wrapper']")
                ?? media.parentElement) as HTMLElement | null;
            if (!wrapper) { if (!cancelled) setOverlayFailed(true); return; }
            if (getComputedStyle(wrapper).position === "static") wrapper.style.position = "relative";
            container = document.createElement("div");
            container.className = "cwg-overlay-host";
            wrapper.appendChild(container);
            if (!cancelled) setHost(container);
        };
        run();

        return () => {
            cancelled = true;
            clearTimeout(timer);
            setHost(null);
            container?.remove();
        };
    }, [att.id, wantOverlay]);

    if (!meta) {
        if (settings.store.autoScan) return null;
        return (
            <div className="cwg-badge">
                <button className="cwg-check" disabled={busy} onClick={scan}>
                    <NodeIcon size={13} />{busy ? "Checking…" : "Check workflow"}
                </button>
            </div>
        );
    }

    if (!meta.ok) {
        return settings.store.autoScan
            ? null
            : <div className="cwg-badge"><span className="cwg-none">No ComfyUI workflow</span></div>;
    }

    const showBelow = !canOverlay || mode === "below" || mode === "both" || (mode === "overlay" && overlayFailed);

    return (
        <>
            <span ref={anchorRef} className="cwg-anchor" data-cwg={String(att.id)} />
            {host && wantOverlay && ReactDOM.createPortal(<BadgePill att={att} meta={meta} source={source} compact />, host)}
            {showBelow && <BadgePill att={att} meta={meta} source={source} />}
        </>
    );
}

function messageLinkOf(message: any): string | undefined {
    try {
        const guildId = ChannelStore.getChannel(message.channel_id)?.guild_id ?? "@me";
        return `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`;
    } catch { return undefined; }
}

/** Pretty channel info for grouping saved workflows by where they were collected. */
function channelMetaOf(message: any): { channelId?: string; channelName?: string; } {
    try {
        const ch = ChannelStore.getChannel(message.channel_id);
        return { channelId: message.channel_id, channelName: ch?.name ? `#${ch.name}` : "Direct Messages" };
    } catch { return {}; }
}

function Accessory({ message }: { message: any; }) {
    const atts = (message?.attachments ?? [])
        .map((a: any) => ({ a, kind: kindOf(a) }))
        .filter((x: any) => x.kind);
    // a workflow can also be pasted as raw JSON / a code block in the message body
    const textGraph = React.useMemo(() => findGraphInText(message?.content), [message?.content]);
    if (!atts.length && !textGraph) return null;

    // pair "<base>.workflow.json" / "<base>.workflow2.json" / "<base>.json" sidecars (a whole
    // workflow chain may have been attached) with their "<base>.<videoext>" video
    const orderKey = (fn: string) => { const m = /\.workflow(\d+)\.json$/i.exec(fn); return m ? parseInt(m[1], 10) : 0; };
    const sidecarsByBase = new Map<string, any[]>();
    for (const { a, kind } of atts) {
        if (kind !== "json") continue;
        const fn = String(a.filename ?? "").toLowerCase();
        const b = fn.replace(/\.workflow\d*\.json$/, "").replace(/\.json$/, "");
        if (!b) continue;
        (sidecarsByBase.get(b) ?? sidecarsByBase.set(b, []).get(b)!).push(a);
    }
    for (const arr of sidecarsByBase.values())
        arr.sort((x, y) => orderKey(String(x.filename ?? "")) - orderKey(String(y.filename ?? "")));

    const sidecarsFor = (a: any, kind: string) => {
        if (kind !== "video") return undefined;
        return sidecarsByBase.get(String(a.filename ?? "").toLowerCase().replace(/\.[^.]+$/, ""));
    };
    const usedJsonIds = new Set<string>();
    for (const { a, kind } of atts)
        for (const sj of sidecarsFor(a, kind) ?? []) usedJsonIds.add(sj.id);

    const messageLink = messageLinkOf(message);
    const chan = channelMetaOf(message);
    return (
        <>
            {atts
                .filter(({ a, kind }: any) => !(kind === "json" && usedJsonIds.has(a.id))) // hide sidecars; they badge their video
                .map(({ a, kind }: any) => (
                    <WorkflowControls
                        key={a.id}
                        att={a}
                        kind={kind}
                        metaAtts={sidecarsFor(a, kind)}
                        source={{ messageId: message.id, messageLink, ...chan, sourceUrl: a.url, isImage: kind === "png" || kind === "webp" }}
                    />
                ))}
            {textGraph && (
                <BadgePill
                    att={{ id: `txt-${message.id}`, filename: "pasted-workflow.json", content_type: "application/json" }}
                    meta={textGraph}
                    source={{ messageId: message.id, messageLink, ...chan }}
                />
            )}
        </>
    );
}

export default definePlugin({
    name: "ComfyPeeper",
    description:
        "Detects ComfyUI workflows in Discord media (PNG/WebP/MP4/WebM/MKV), .json files, or pasted JSON, " +
        "badges them, and lets you preview the graph + parameters, copy/save the JSON, or queue it directly " +
        "to a ComfyUI instance (local or remote, with a missing-node check).",
    authors: [{ name: "ethanfel", id: 0n }],
    settings,

    renderMessageAccessory: props => (
        <ErrorBoundary noop>
            <Accessory message={props.message} />
        </ErrorBoundary>
    ),

    // always-available entry point to the saved-workflow library (Vencord toolbox)
    toolboxActions: {
        "Open ComfyPeeper Library": () => openLibraryModal()
    },

    // right-click an image/video → associate it with a saved workflow's preview
    contextMenus: {
        "image-context": imageAssociateContextPatch,
        "message": messageAssociateContextPatch
    },

    // warm the library snapshot so the associate submenu can list recent entries synchronously
    start() { void warmLibraryCache(); },

    // attach a workflow .json sidecar when uploading a workflow-bearing video
    onBeforeMessageSend
});
