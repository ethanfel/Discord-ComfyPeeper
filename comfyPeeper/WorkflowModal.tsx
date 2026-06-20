/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button, Modal, openModal, React, showToast, Toasts, useEffect, useState } from "@webpack/common";

import { NodeIcon } from "./icons";
import { entryId, hasEntry, SaveSource, saveToLibrary } from "./library";
import { openLibraryModal } from "./LibraryModal";
import { settings } from "./settings";
import { checkServer, copyWithToast, downloadJson, extractParams, parseEndpoints, queue, ServerCheck, WorkflowMeta } from "./utils";
import { WorkflowGraph } from "./WorkflowGraph";

const pretty = (text?: string) => {
    if (!text) return "";
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
};

// NOTE: must be a block list, not a flex column — a flex column flex-shrinks the many
// cards to ~1px. Explicit line-height keeps the text-selection highlight aligned to glyphs.
const LH = "1.5";
const S = {
    wrap: { overflowY: "auto", maxHeight: "64vh", display: "block" } as const,
    node: { border: "1px solid #ffffff1f", borderRadius: "6px", overflow: "hidden", background: "#00000026", marginBottom: "8px" } as const,
    title: { background: "#5865f2", color: "#fff", fontWeight: 700, fontSize: "13px", lineHeight: LH, padding: "5px 10px" } as const,
    row: { display: "flex", gap: "10px", padding: "3px 10px", fontSize: "12px", lineHeight: LH, borderTop: "1px solid #ffffff14", fontFamily: "monospace" } as const,
    k: { flex: "0 0 42%", color: "#aab4c0", lineHeight: LH } as const,
    v: { flex: "1 1 auto", color: "#fff", wordBreak: "break-word", whiteSpace: "pre-wrap", lineHeight: LH } as const,
    empty: { padding: "3px 10px", fontSize: "12px", color: "#8a8a8a", fontStyle: "italic" } as const,
    none: { color: "#b9b9b9", fontStyle: "italic", padding: "12px" } as const
};

function ParamsView({ prompt, workflow }: { prompt?: string; workflow?: string; }) {
    const params = extractParams(prompt, workflow);
    if (!params.length) return <div style={S.none}>No parameters found in this graph.</div>;
    return (
        <div className="cwg-selectable" style={S.wrap}>
            {params.map(p => {
                const entries = Object.entries(p.inputs);
                return (
                    <div key={p.id} style={S.node}>
                        <div style={S.title}>#{p.id} · {p.classType}</div>
                        {entries.length === 0
                            ? <div style={S.empty}>(no widget values — all inputs are connections)</div>
                            : entries.map(([k, v]) => (
                                <div key={k} style={S.row}>
                                    <span style={S.k}>{k}</span>
                                    <span style={S.v}>{v}</span>
                                </div>
                            ))}
                    </div>
                );
            })}
        </div>
    );
}

function JsonView({ meta, base }: { meta: WorkflowMeta; base: string; }) {
    const [which, setWhich] = useState<"workflow" | "prompt">(meta.workflow ? "workflow" : "prompt");
    const text = which === "workflow" ? meta.workflow : meta.prompt;
    return (
        <div className="cwg-json">
            <div className="cwg-json-head">
                {meta.workflow && <button className={which === "workflow" ? "active" : ""} onClick={() => setWhich("workflow")}>workflow (editor)</button>}
                {meta.prompt && <button className={which === "prompt" ? "active" : ""} onClick={() => setWhich("prompt")}>prompt (API)</button>}
                <button className="cwg-json-copy" onClick={() => copyWithToast(text ?? "", "Copied")}>Copy</button>
                <button onClick={() => text && downloadJson(`${base}.${which}.json`, text)}>⬇ .json</button>
            </div>
            <pre className="cwg-pre cwg-selectable">{pretty(text)}</pre>
        </div>
    );
}

function WorkflowModal({ rootProps, att, meta, source }: { rootProps: any; att: any; meta: WorkflowMeta; source?: SaveSource; }) {
    // a file can embed several graphs (a processing chain) — let the user switch between them
    const variants = meta.variants?.length ? meta.variants : [{ label: "Workflow", workflow: meta.workflow, prompt: meta.prompt }];
    const multi = variants.length > 1;
    const [vi, setVi] = useState(0);
    const v = variants[Math.min(vi, variants.length - 1)];

    const [tab, setTab] = useState<"graph" | "params" | "json">(v.workflow ? "graph" : (v.prompt ? "params" : "json"));
    const [compat, setCompat] = useState<ServerCheck[] | null>(null);
    const [checking, setChecking] = useState(false);
    const [hl, setHl] = useState<{ label: string; missing: string[]; } | null>(null);
    const [saved, setSaved] = useState(false);
    const endpoints = parseEndpoints(settings.store.endpoints);

    const idFor = (i: number) => (source?.id ?? entryId(att, source)) + (multi ? `#${i}` : "");
    useEffect(() => { hasEntry(idFor(vi)).then(setSaved); }, [vi]);
    const onSave = async () => {
        const title = multi ? `${att.filename || "workflow"} — ${v.label}` : (att.filename || "workflow");
        await saveToLibrary({ ...att, filename: title }, { workflow: v.workflow, prompt: v.prompt, kind: meta.kind }, { ...source, id: idFor(vi) });
        setSaved(true);
        showToast("Saved to library ★", Toasts.Type.SUCCESS);
    };
    const switchVariant = (i: number) => {
        setVi(i); setCompat(null); setHl(null);
        const nv = variants[i];
        setTab(nv.workflow ? "graph" : (nv.prompt ? "params" : "json"));
    };
    const base = (att.filename || "workflow").replace(/\.[^.]+$/, "");
    const isVideo = (att.content_type || "").includes("video") || /\.(mp4|mov|m4v|webm|mkv)$/i.test(att.filename || "");
    const isImage = (att.content_type || "").includes("image") || /\.(png|webp|jpe?g|gif)$/i.test(att.filename || "");
    const showMedia = isImage || isVideo; // a .json attachment has nothing to preview

    const runCheck = async () => {
        setChecking(true);
        try { setCompat(await Promise.all(endpoints.map(ep => checkServer(ep, v.prompt!)))); }
        finally { setChecking(false); }
    };

    const compatLine = (c: ServerCheck) => {
        if (!c.ok) return { color: "#e0a030", text: `⚠ ${c.ep.label}: unreachable (${c.error || "error"})` };
        if ((c.missing?.length ?? 0) === 0) return { color: "#43b581", text: `✓ ${c.ep.label}: all ${c.total} nodes available — can run` };
        return { color: "#e05555", text: `✗ ${c.ep.label}: missing ${c.missing!.length} of ${c.total} — ${c.missing!.join(", ")}` };
    };

    return (
        <Modal {...rootProps} size="xl" title={<span className="cwg-modal-title" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}><NodeIcon size={18} />ComfyUI Workflow — {att.filename || "image"}</span>}>
            <div className="cwg-modal-body">
                {showMedia && (
                    <div className="cwg-modal-media">
                        {isVideo
                            ? <video className="cwg-media" src={att.url} controls loop />
                            : <img className="cwg-media" src={att.url} alt={att.filename} />}
                    </div>
                )}
                <div className="cwg-modal-panel">
                    {multi && (
                        <div className="cwg-variants" title="This file embeds more than one workflow (e.g. a generation + post-processing chain)">
                            {variants.map((vv, i) => (
                                <button key={i} className={i === vi ? "active" : ""} onClick={() => switchVariant(i)}>{vv.label}</button>
                            ))}
                        </div>
                    )}
                    <div className="cwg-tabs">
                        {v.workflow && <button className={tab === "graph" ? "active" : ""} onClick={() => setTab("graph")}>Graph</button>}
                        {(v.prompt || v.workflow) && <button className={tab === "params" ? "active" : ""} onClick={() => setTab("params")}>Parameters</button>}
                        <button className={tab === "json" ? "active" : ""} onClick={() => setTab("json")}>JSON</button>
                    </div>
                    {hl && tab === "graph" && (
                        <div style={{ fontSize: "11px", color: "#ff8585", padding: "0 0 4px" }}>
                            Highlighting {hl.missing.length} node(s) missing on {hl.label} ·{" "}
                            <span style={{ cursor: "pointer", textDecoration: "underline" }} onClick={() => setHl(null)}>clear</span>
                        </div>
                    )}
                    <div className="cwg-tabcontent">
                        {tab === "graph" && <WorkflowGraph workflow={v.workflow!} prompt={v.prompt} missing={hl?.missing} />}
                        {tab === "params" && <ParamsView prompt={v.prompt} workflow={v.workflow} />}
                        {tab === "json" && <JsonView meta={{ ...meta, workflow: v.workflow, prompt: v.prompt }} base={base} />}
                    </div>
                </div>
            </div>

            {compat && (
                <div className="cwg-selectable" style={{ display: "flex", flexDirection: "column", gap: "2px", padding: "6px 2px", fontSize: "12px", fontFamily: "monospace" }}>
                    {compat.map(c => {
                        const { color, text } = compatLine(c);
                        const canHighlight = c.ok && (c.missing?.length ?? 0) > 0 && !!v.workflow;
                        return (
                            <div
                                key={c.ep.url}
                                style={{ color, cursor: canHighlight ? "pointer" : "default" }}
                                onClick={canHighlight ? () => { setHl({ label: c.ep.label, missing: c.missing! }); setTab("graph"); } : undefined}
                            >
                                {text}{canHighlight && "  ⟵ click to show on graph"}
                            </div>
                        );
                    })}
                </div>
            )}

            <div className="cwg-footer">
                <Button size={Button.Sizes.SMALL} color={saved ? Button.Colors.GREEN : Button.Colors.BRAND} disabled={saved} onClick={onSave}>
                    {saved ? "★ Saved" : "★ Save"}
                </Button>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => { rootProps.onClose(); openLibraryModal(); }}>📚 Library</Button>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => copyWithToast(v.workflow ?? v.prompt ?? "", "Copied")}>Copy</Button>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => downloadJson(`${base}.json`, v.workflow ?? v.prompt ?? "")}>Save .json</Button>
                {v.prompt && endpoints.length > 0 && (
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} disabled={checking} onClick={runCheck}>
                        {checking ? "Checking…" : "Check servers"}
                    </Button>
                )}
                {v.prompt && endpoints.map(ep => (
                    <Button key={ep.url} size={Button.Sizes.SMALL} color={Button.Colors.GREEN} onClick={() => queue(ep, v.prompt!)}>
                        ▶ {endpoints.length > 1 ? ep.label : "Queue"}
                    </Button>
                ))}
            </div>
        </Modal>
    );
}

export function openWorkflowModal(att: any, meta: WorkflowMeta, source?: SaveSource) {
    openModal(rootProps => <WorkflowModal rootProps={rootProps} att={att} meta={meta} source={source} />);
}
