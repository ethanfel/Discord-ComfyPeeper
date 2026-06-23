/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button, Modal, NavigationRouter, openModal, React, showToast, Toasts, useEffect, useState } from "@webpack/common";

import { NodeIcon } from "./icons";
import { backupEntry, canBackup, ConflictResolve, countConflicts, exportLibrary, getLibrary, importLibrary, parseLibraryFile, removeEntry, SavedWf } from "./library";
import { openWorkflowModal } from "./WorkflowModal";

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

function relTime(ts: number): string {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return new Date(ts).toLocaleDateString();
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

/** Group by the Discord channel a workflow was collected from; most recently active channel first. */
function groupByChannel(items: SavedWf[]): { label: string; items: SavedWf[]; }[] {
    const map = new Map<string, SavedWf[]>();
    for (const it of items) {
        const label = it.channelName || "Unknown channel";
        (map.get(label) ?? map.set(label, []).get(label)!).push(it);
    }
    return [...map.values()]
        .map(list => ({ label: list[0].channelName || "Unknown channel", items: list.sort((a, b) => b.savedAt - a.savedAt) }))
        .sort((a, b) => b.items[0].savedAt - a.items[0].savedAt);
}

function openSaved(e: SavedWf) {
    const att = {
        id: e.id,
        filename: e.title,
        // a manually-associated video plays from its source; otherwise show the stored image preview
        content_type: e.mediaIsVideo ? "video/mp4" : (e.thumb ? "image/webp" : "application/json"),
        url: e.mediaIsVideo ? (e.sourceUrl || e.thumb) : (e.thumb || e.sourceUrl)
    };
    const hasMedia = !!e.mediaIsVideo || !!e.thumb;
    openWorkflowModal(
        att,
        { ok: true, kind: e.kind as any, workflow: e.workflow, prompt: e.prompt },
        {
            id: e.id, messageLink: e.messageLink, sourceUrl: e.sourceUrl, channelId: e.channelId, channelName: e.channelName,
            mediaUrl: hasMedia ? e.sourceUrl : undefined, mediaIsVideo: e.mediaIsVideo, localPath: e.localPath
        }
    );
}

function jump(link?: string) {
    if (!link) return;
    try { NavigationRouter.transitionTo(new URL(link).pathname); }
    catch { /* ignore bad link */ }
}

function Card({ e, onDelete, onChanged, close }: { e: SavedWf; onDelete: () => void; onChanged: () => void; close: () => void; }) {
    const [backing, setBacking] = useState(false);
    const open = () => { close(); openSaved(e); };
    const post = () => { close(); jump(e.messageLink); };
    const doBackup = async () => {
        setBacking(true);
        showToast("Backing up locally…", Toasts.Type.MESSAGE);
        const r = await backupEntry(e);
        setBacking(false);
        if (r.ok) { showToast("Backed up locally ✓", Toasts.Type.SUCCESS); onChanged(); }
        else showToast(`Backup failed: ${r.error || "error"}`, Toasts.Type.FAILURE);
    };
    return (
        <div className="cwg-lib-card">
            <div className="cwg-lib-thumb" onClick={open} title="Open preview">
                {e.thumb
                    ? <img src={e.thumb} alt={e.title} />
                    : <div className="cwg-lib-noimg"><NodeIcon size={30} /></div>}
                <span className="cwg-lib-kind">{e.kind}</span>
                {e.localPath && <span className="cwg-lib-saved" title={"Backed up locally: " + e.localPath}>💾</span>}
            </div>
            <div className="cwg-lib-body">
                <div className="cwg-lib-title" title={e.title}>{e.title}</div>
                <div className="cwg-lib-date" title={new Date(e.savedAt).toLocaleString()}>{relTime(e.savedAt)}</div>
            </div>
            <div className="cwg-lib-actions">
                <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={open}>Open</Button>
                {e.messageLink && <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={post}>Post</Button>}
                {!e.localPath && canBackup(e) && (
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} disabled={backing} onClick={doBackup}>
                        {backing ? "Backing…" : "💾 Backup"}
                    </Button>
                )}
                <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} onClick={onDelete}>Delete</Button>
            </div>
        </div>
    );
}

const RESOLVE_OPTS: { v: ConflictResolve; label: string; }[] = [
    { v: "newest", label: "Keep the newest (by save date)" },
    { v: "existing", label: "Keep what I already have" },
    { v: "imported", label: "Use the imported version" }
];

function ImportDialog({ rootProps, total, conflicts, onConfirm }: { rootProps: any; total: number; conflicts: number; onConfirm: (r: ConflictResolve) => void; }) {
    const [resolve, setResolve] = useState<ConflictResolve>("newest");
    const apply = () => { rootProps.onClose(); onConfirm(resolve); };
    return (
        <Modal {...rootProps} size="sm" title={
            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexGrow: 1 }}><NodeIcon size={18} />Import library</span>
        }>
            <div style={{ padding: "6px 2px 10px", color: "#c7ccd4", fontSize: "13px", lineHeight: 1.5 }}>
                Importing <b>{total}</b> workflow{total === 1 ? "" : "s"}.{" "}
                {conflicts > 0
                    ? <><b>{conflicts}</b> already in your library — how should conflicts be resolved?</>
                    : "None are already in your library."}
            </div>
            {conflicts > 0 && (
                <div className="cwg-lib-import-opts">
                    {RESOLVE_OPTS.map(o => (
                        <label key={o.v}>
                            <input type="radio" name="cwg-resolve" checked={resolve === o.v} onChange={() => setResolve(o.v)} />
                            {o.label}
                        </label>
                    ))}
                </div>
            )}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "16px" }}>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => rootProps.onClose()}>Cancel</Button>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={apply}>Import</Button>
            </div>
        </Modal>
    );
}

function LibraryModal({ rootProps }: { rootProps: any; }) {
    const [items, setItems] = useState<SavedWf[] | null>(null);
    const [query, setQuery] = useState("");
    const fileRef = React.useRef<HTMLInputElement>(null);
    const reload = () => { getLibrary().then(setItems); };
    useEffect(reload, []);

    const doExport = async () => {
        try {
            const n = await exportLibrary();
            showToast(`Exported ${n} workflow${n === 1 ? "" : "s"}`, Toasts.Type.SUCCESS);
        } catch { showToast("Export failed", Toasts.Type.FAILURE); }
    };
    const onFile = async (ev: React.ChangeEvent<HTMLInputElement>) => {
        const file = ev.currentTarget.files?.[0];
        ev.currentTarget.value = ""; // allow re-picking the same file
        if (!file) return;
        let entries;
        try { entries = parseLibraryFile(await file.text()); }
        catch { showToast("Not a valid ComfyPeeper library file", Toasts.Type.FAILURE); return; }
        if (!entries.length) { showToast("No workflows found in that file", Toasts.Type.FAILURE); return; }
        const conflicts = await countConflicts(entries);
        openModal(rp => (
            <ImportDialog
                rootProps={rp}
                total={entries.length}
                conflicts={conflicts}
                onConfirm={async resolve => {
                    const r = await importLibrary(entries, resolve);
                    reload();
                    showToast(`Imported: ${r.added} new, ${r.updated} updated, ${r.skipped} skipped`, Toasts.Type.SUCCESS);
                }}
            />
        ));
    };

    // searchable text per entry: filename + channel + the workflow/prompt JSON (built once per load)
    const haystacks = React.useMemo(() => {
        const m = new Map<string, string>();
        for (const e of items ?? [])
            m.set(e.id, `${e.title}\n${e.channelName ?? ""}\n${e.workflow ?? ""}\n${e.prompt ?? ""}`.toLowerCase());
        return m;
    }, [items]);

    const q = query.trim().toLowerCase();
    const visible = items ? (q ? items.filter(e => haystacks.get(e.id)?.includes(q)) : items) : null;

    // primary timeline by date; within each date, split by the channel it was collected from
    const groups = visible
        ? groupByDate(visible).map(d => ({ label: d.label, total: d.items.length, channels: groupByChannel(d.items) }))
        : [];

    return (
        <Modal {...rootProps} size="lg" title={
            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexGrow: 1 }}>
                <NodeIcon size={18} />ComfyPeeper Library {items ? `(${items.length})` : ""}
            </span>
        }>
            {items !== null && (
                <div className="cwg-lib-tools">
                    {!!items.length && (
                        <div className="cwg-lib-search">
                            <input
                                type="text"
                                value={query}
                                onChange={e => setQuery(e.currentTarget.value)}
                                placeholder="Search name, channel, or workflow contents…"
                                autoFocus
                            />
                            {q ? <button className="cwg-lib-search-clear" title="Clear" onClick={() => setQuery("")}>✕</button> : null}
                            {q ? <span className="cwg-lib-search-count">{visible!.length} match{visible!.length === 1 ? "" : "es"}</span> : null}
                        </div>
                    )}
                    <button className="cwg-lib-tool" disabled={!items.length} onClick={doExport} title="Download the whole library as a .json">⬇ Export</button>
                    <button className="cwg-lib-tool" onClick={() => fileRef.current?.click()} title="Import a library .json (merge with conflict resolution)">⬆ Import</button>
                    <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={onFile} />
                </div>
            )}
            <div className="cwg-lib">
                {items === null
                    ? <div className="cwg-lib-empty">Loading…</div>
                    : items.length === 0
                        ? <div className="cwg-lib-empty">No saved workflows yet.<br />Open a workflow and hit <b>★ Save</b>.</div>
                        : visible!.length === 0
                            ? <div className="cwg-lib-empty">No workflows match “{query.trim()}”.</div>
                            : <div className="cwg-lib-timeline cwg-selectable">
                                {groups.map(d => (
                                    <div className="cwg-lib-section" key={d.label}>
                                        <div className="cwg-lib-head">{d.label}<span className="cwg-lib-count">{d.total}</span></div>
                                        {d.channels.map(c => (
                                            <div className="cwg-lib-chan-group" key={c.label}>
                                                <div className="cwg-lib-chan"><span className="cwg-lib-chan-name">{c.label}</span><span className="cwg-lib-chan-count">{c.items.length}</span></div>
                                                <div className="cwg-lib-grid">
                                                    {c.items.map(e => <Card key={e.id} e={e} close={rootProps.onClose} onChanged={reload} onDelete={() => removeEntry(e.id).then(reload)} />)}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ))}
                            </div>}
            </div>
        </Modal>
    );
}

export function openLibraryModal() {
    openModal(rootProps => <LibraryModal rootProps={rootProps} />);
}
