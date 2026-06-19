/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button, Modal, openModal, React, useState } from "@webpack/common";

import { NodeIcon } from "./icons";
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

function JsonView({ meta }: { meta: WorkflowMeta; }) {
    const [which, setWhich] = useState<"workflow" | "prompt">(meta.workflow ? "workflow" : "prompt");
    const text = which === "workflow" ? meta.workflow : meta.prompt;
    return (
        <div className="cwg-json">
            <div className="cwg-json-head">
                {meta.workflow && <button className={which === "workflow" ? "active" : ""} onClick={() => setWhich("workflow")}>workflow (editor)</button>}
                {meta.prompt && <button className={which === "prompt" ? "active" : ""} onClick={() => setWhich("prompt")}>prompt (API)</button>}
                <button className="cwg-json-copy" onClick={() => copyWithToast(text ?? "", "Copied")}>Copy</button>
            </div>
            <pre className="cwg-pre cwg-selectable">{pretty(text)}</pre>
        </div>
    );
}

function WorkflowModal({ rootProps, att, meta }: { rootProps: any; att: any; meta: WorkflowMeta; }) {
    const [tab, setTab] = useState<"graph" | "params" | "json">(meta.workflow ? "graph" : (meta.prompt ? "params" : "json"));
    const [compat, setCompat] = useState<ServerCheck[] | null>(null);
    const [checking, setChecking] = useState(false);
    const [hl, setHl] = useState<{ label: string; missing: string[]; } | null>(null);
    const endpoints = parseEndpoints(settings.store.endpoints);
    const base = (att.filename || "workflow").replace(/\.[^.]+$/, "");
    const isVideo = (att.content_type || "").includes("video") || /\.(mp4|mov|m4v|webm|mkv)$/i.test(att.filename || "");
    const isImage = (att.content_type || "").includes("image") || /\.(png|webp|jpe?g|gif)$/i.test(att.filename || "");
    const showMedia = isImage || isVideo; // a .json attachment has nothing to preview

    const runCheck = async () => {
        setChecking(true);
        try { setCompat(await Promise.all(endpoints.map(ep => checkServer(ep, meta.prompt!)))); }
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
                    <div className="cwg-tabs">
                        {meta.workflow && <button className={tab === "graph" ? "active" : ""} onClick={() => setTab("graph")}>Graph</button>}
                        {(meta.prompt || meta.workflow) && <button className={tab === "params" ? "active" : ""} onClick={() => setTab("params")}>Parameters</button>}
                        <button className={tab === "json" ? "active" : ""} onClick={() => setTab("json")}>JSON</button>
                    </div>
                    {hl && tab === "graph" && (
                        <div style={{ fontSize: "11px", color: "#ff8585", padding: "0 0 4px" }}>
                            Highlighting {hl.missing.length} node(s) missing on {hl.label} ·{" "}
                            <span style={{ cursor: "pointer", textDecoration: "underline" }} onClick={() => setHl(null)}>clear</span>
                        </div>
                    )}
                    <div className="cwg-tabcontent">
                        {tab === "graph" && <WorkflowGraph workflow={meta.workflow!} prompt={meta.prompt} missing={hl?.missing} />}
                        {tab === "params" && <ParamsView prompt={meta.prompt} workflow={meta.workflow} />}
                        {tab === "json" && <JsonView meta={meta} />}
                    </div>
                </div>
            </div>

            {compat && (
                <div className="cwg-selectable" style={{ display: "flex", flexDirection: "column", gap: "2px", padding: "6px 2px", fontSize: "12px", fontFamily: "monospace" }}>
                    {compat.map(c => {
                        const { color, text } = compatLine(c);
                        const canHighlight = c.ok && (c.missing?.length ?? 0) > 0 && !!meta.workflow;
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
                {meta.workflow && <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => copyWithToast(meta.workflow!, "Workflow JSON copied")}>Copy workflow</Button>}
                {meta.workflow && <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => downloadJson(`${base}.workflow.json`, meta.workflow!)}>Save workflow .json</Button>}
                {meta.prompt && <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => downloadJson(`${base}.prompt.json`, meta.prompt!)}>Save prompt .json</Button>}
                {meta.prompt && endpoints.length > 0 && (
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} disabled={checking} onClick={runCheck}>
                        {checking ? "Checking…" : "Check servers"}
                    </Button>
                )}
                {meta.prompt && endpoints.map(ep => (
                    <Button key={ep.url} size={Button.Sizes.SMALL} color={Button.Colors.GREEN} onClick={() => queue(ep, meta.prompt!)}>
                        ▶ {endpoints.length > 1 ? `Queue → ${ep.label}` : "Queue in ComfyUI"}
                    </Button>
                ))}
            </div>
        </Modal>
    );
}

export function openWorkflowModal(att: any, meta: WorkflowMeta) {
    openModal(rootProps => <WorkflowModal rootProps={rootProps} att={att} meta={meta} />);
}
