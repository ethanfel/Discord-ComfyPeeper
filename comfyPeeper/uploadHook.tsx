/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageObject, MessageSendListener } from "@api/MessageEvents";
import { CloudUpload as TCloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { Button, Modal, openModal, React, showToast, Toasts, useState } from "@webpack/common";

import { NodeIcon } from "./icons";
import { settings } from "./settings";
import { findGraphInText, logger } from "./utils";

const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv)$/i;
const SLICE = 4 * 1024 * 1024; // webm fallback: read 4 MB from each end (Matroska Tags live near the ends)

const baseName = (n: string) => n.replace(/\.[^.]+$/, "");
const getFile = (upload: any): File | null => upload?.item?.file ?? upload?.file ?? null;
const dec = new TextDecoder("iso-8859-1");

interface Candidate { base: string; videoName: string; contents: string[]; }

/** Walk an MP4's box headers (reading only ~16 bytes each) and return the small `moov` atom. */
async function locateMoovInFile(file: File): Promise<Uint8Array | null> {
    let offset = 0;
    for (let guard = 0; guard < 256 && offset + 8 <= file.size; guard++) {
        const head = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
        if (head.length < 8) return null;
        const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
        let size = dv.getUint32(0);
        const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
        if (size === 1) { if (head.length < 16) return null; size = Number(dv.getBigUint64(8)); }
        if (size < 8) return null; // 0 = to-EOF or malformed
        if (type === "moov") return new Uint8Array(await file.slice(offset, offset + size).arrayBuffer());
        offset += size;
    }
    return null;
}

/** Pull every embedded graph out of a scanned text window as bare, ComfyUI-loadable JSON. */
function variantContents(text: string): string[] {
    const m = findGraphInText(text);
    if (!m) return [];
    const vs = m.variants?.length ? m.variants : [{ workflow: m.workflow, prompt: m.prompt }];
    return vs.map(v => v.workflow ?? v.prompt).filter((x): x is string => !!x);
}

/** Read ALL embedded workflows out of a local video file, before Discord strips them. */
async function readVariantsFromFile(file: File): Promise<string[]> {
    try {
        // MP4/MOV: isolate the (small) moov atom and scan only that — fast, no binary brace-walking.
        const sig = new Uint8Array(await file.slice(0, 12).arrayBuffer());
        if (String.fromCharCode(sig[4], sig[5], sig[6], sig[7]) === "ftyp") {
            const moov = await locateMoovInFile(file);
            if (moov) { const c = variantContents(dec.decode(moov)); if (c.length) return c; }
        }
        // WebM/MKV (or odd MP4): scan head, then tail window
        const head = variantContents(dec.decode(await file.slice(0, SLICE).arrayBuffer()));
        if (head.length) return head;
        if (file.size > SLICE) return variantContents(dec.decode(await file.slice(Math.max(0, file.size - SLICE)).arrayBuffer()));
        return [];
    } catch (e) {
        logger.warn("upload scan failed", e);
        return [];
    }
}

async function findWorkflowVideos(uploads: any[]): Promise<Candidate[]> {
    const existing = new Set(uploads.map(u => String(u.filename ?? getFile(u)?.name ?? "").toLowerCase()));
    const out: Candidate[] = [];
    for (const up of uploads) {
        const name = String(up.filename ?? getFile(up)?.name ?? "");
        if (!VIDEO_RE.test(name)) continue;
        const file = getFile(up);
        if (!file) continue;
        const contents = await readVariantsFromFile(file);
        if (!contents.length) continue;
        const base = baseName(name);
        if (existing.has(`${base}.workflow.json`.toLowerCase())) continue; // already attached manually
        out.push({ base, videoName: name, contents });
    }
    return out;
}

function ChooseDialog({ rootProps, candidates, resolve }: { rootProps: any; candidates: Candidate[]; resolve: (c: Candidate[]) => void; }) {
    const [sel, setSel] = useState<Set<string>>(() => new Set(candidates.map(c => c.base)));
    const toggle = (b: string) => setSel(s => { const n = new Set(s); n.has(b) ? n.delete(b) : n.add(b); return n; });
    const done = (chosen: Candidate[]) => { resolve(chosen); rootProps.onClose(); };

    return (
        <Modal {...rootProps} size="sm" title={
            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexGrow: 1 }}>
                <NodeIcon size={18} />Attach workflow{candidates.length > 1 ? "s" : ""}?
            </span>
        }>
            <div style={{ padding: "6px 2px 12px", color: "#c7ccd4", fontSize: "13px", lineHeight: 1.5 }}>
                Discord may strip the embedded ComfyUI workflow from {candidates.length > 1 ? "these videos" : "this video"}.
                Attach it as a <b>.json</b> so it survives for everyone.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {candidates.map(c => (
                    <label key={c.base} style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px" }}>
                        <input type="checkbox" checked={sel.has(c.base)} onChange={() => toggle(c.base)} style={{ accentColor: "#5865f2" }} />
                        <span style={{ color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.videoName}</span>
                        <span style={{ color: "#8a93a0", flexShrink: 0 }}>→ {c.contents.length} workflow{c.contents.length > 1 ? "s" : ""}</span>
                    </label>
                ))}
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "16px" }}>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => done([])}>Skip</Button>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={() => done(candidates.filter(c => sel.has(c.base)))}>Attach selected</Button>
            </div>
        </Modal>
    );
}

function askWhichToAttach(candidates: Candidate[]): Promise<Candidate[]> {
    return new Promise(resolve => {
        let settled = false;
        const finish = (c: Candidate[]) => { if (!settled) { settled = true; resolve(c); } };
        openModal(
            rootProps => <ChooseDialog rootProps={rootProps} candidates={candidates} resolve={finish} />,
            { onCloseCallback: () => finish([]) }
        );
        setTimeout(() => finish([]), 120_000); // safety: never hang a send
    });
}

/** Attach one .json sidecar per embedded workflow so the whole chain survives stripping.
 *  Names: "<base>.workflow.json" (primary), then "<base>.workflow2.json", "<base>.workflow3.json", … */
async function attachWorkflows(channelId: string, options: any, c: Candidate): Promise<number> {
    let done = 0;
    for (let i = 0; i < c.contents.length; i++) {
        const name = i === 0 ? `${c.base}.workflow.json` : `${c.base}.workflow${i + 1}.json`;
        const file = new File([c.contents[i]], name, { type: "application/json" });
        const up = new CloudUpload({ file, isThumbnail: false, platform: CloudUploadPlatform.WEB }, channelId);
        await new Promise<void>((res, rej) => {
            up.on("complete", () => res());
            up.on("error", () => rej(new Error("upload failed")));
            up.upload();
        });
        (options.uploads ??= []).push(up);
        done++;
    }
    return done;
}

/** Before sending: if any uploaded video carries a ComfyUI workflow, attach it as a .json sidecar. */
export const onBeforeMessageSend: MessageSendListener = async (channelId, _msg: MessageObject, options) => {
    try {
        if (!settings.store.attachWorkflowOnUpload) return;
        const uploads = options?.uploads;
        if (!uploads?.length) return;

        const candidates = await findWorkflowVideos(uploads);
        if (!candidates.length) return;

        const chosen = settings.store.attachMode === "auto" ? candidates : await askWhichToAttach(candidates);
        if (!chosen.length) return;

        let done = 0;
        for (const c of chosen) {
            try { done += await attachWorkflows(channelId, options, c); }
            catch (e) { logger.error("attach workflow failed for " + c.videoName, e); }
        }
        if (done) showToast(`Attached ${done} workflow .json${done > 1 ? "s" : ""}`, Toasts.Type.SUCCESS);
    } catch (e) {
        logger.error("onBeforeMessageSend error", e); // never block the send
    }
};
