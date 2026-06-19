/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { Button, React, ReactDOM, useEffect, useRef, useState } from "@webpack/common";

import { NodeIcon } from "./icons";
import { settings } from "./settings";
import { copyWithToast, downloadJson, getMeta, kindOf, parseEndpoints, queue, WorkflowMeta } from "./utils";
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

function BadgePill({ att, meta, compact }: { att: any; meta: WorkflowMeta; compact?: boolean; }) {
    const endpoints = parseEndpoints(settings.store.endpoints);
    const json = meta.workflow ?? meta.prompt!;
    const baseName = (att.filename || "workflow").replace(/\.[^.]+$/, "");
    const kindTag = meta.kind && meta.kind !== "png" ? ` (${meta.kind})` : "";

    return (
        <div className={"cwg-badge" + (compact ? " cwg-compact" : "")}>
            <span
                className="cwg-tag"
                role="button"
                title="Open ComfyUI workflow preview"
                onClick={() => openWorkflowModal(att, meta)}
            >
                <NodeIcon />{compact ? "ComfyUI" : "ComfyUI workflow"}{kindTag}
            </span>

            {!compact && <>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={() => openWorkflowModal(att, meta)}>Preview</Button>
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

function WorkflowControls({ att, kind }: { att: any; kind: "png" | "webp" | "video"; }) {
    const [meta, setMeta] = useState<WorkflowMeta | null>(null);
    const [busy, setBusy] = useState(false);
    const [host, setHost] = useState<HTMLElement | null>(null);
    const [overlayFailed, setOverlayFailed] = useState(false);
    const anchorRef = useRef<HTMLSpanElement>(null);

    const scan = () => {
        setBusy(true);
        getMeta(att, kind).then(setMeta).finally(() => setBusy(false));
    };

    useEffect(() => {
        if (settings.store.autoScan) scan();
    }, [att.id]);

    const mode = settings.store.badgeMode as "overlay" | "below" | "both";
    const wantOverlay = !!meta?.ok && (mode === "overlay" || mode === "both");

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

    const showBelow = mode === "below" || mode === "both" || (mode === "overlay" && overlayFailed);

    return (
        <>
            <span ref={anchorRef} className="cwg-anchor" data-cwg={String(att.id)} />
            {host && wantOverlay && ReactDOM.createPortal(<BadgePill att={att} meta={meta} compact />, host)}
            {showBelow && <BadgePill att={att} meta={meta} />}
        </>
    );
}

function Accessory({ message }: { message: any; }) {
    const atts = (message?.attachments ?? [])
        .map((a: any) => ({ a, kind: kindOf(a) }))
        .filter((x: any) => x.kind);
    if (!atts.length) return null;
    return <>{atts.map(({ a, kind }: any) => <WorkflowControls key={a.id} att={a} kind={kind} />)}</>;
}

export default definePlugin({
    name: "ComfyPeeper",
    description:
        "Detects ComfyUI workflows embedded in Discord images/videos (PNG, WebP, MP4), badges them, " +
        "and lets you preview the graph, copy/save the JSON, or queue it directly to a ComfyUI instance (local or remote).",
    authors: [{ name: "ethanfel", id: 0n }],
    settings,

    renderMessageAccessory: props => (
        <ErrorBoundary noop>
            <Accessory message={props.message} />
        </ErrorBoundary>
    )
});
