/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "@webpack/common";

const TITLE_H = 30;
const SLOT_H = 20;
const DEFAULT_W = 200;
const MIN_K = 0.05;
const MAX_K = 8;

const num = (v: any, d = 0) => (typeof v === "number" && isFinite(v) ? v : d);
const clamp = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

function getPos(n: any) {
    const p = n.pos;
    if (Array.isArray(p)) return { x: num(p[0]), y: num(p[1]) };
    if (p && typeof p === "object") return { x: num(p[0] ?? p["0"]), y: num(p[1] ?? p["1"]) };
    return { x: 0, y: 0 };
}

function getSize(n: any) {
    const s = n.size;
    let w = DEFAULT_W;
    let h = 0;
    if (Array.isArray(s)) { w = num(s[0], DEFAULT_W); h = num(s[1]); }
    else if (s && typeof s === "object") { w = num(s[0] ?? s["0"], DEFAULT_W); h = num(s[1] ?? s["1"]); }
    const slots = Math.max((n.inputs?.length ?? 0), (n.outputs?.length ?? 0), 1);
    return { w: Math.max(60, w), h: Math.max(h, TITLE_H + slots * SLOT_H + 8) };
}

const trunc = (s: string, w: number) => {
    const max = Math.max(6, Math.floor(w / 8));
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
};

interface View { k: number; x: number; y: number; }

const WIDGET_H = 16;

/** Lines to show inside a node body: prefer the API graph's named inputs, else raw widget values. */
function bodyLines(node: any, promptInputs: Record<string, any> | undefined): string[] {
    const lines: string[] = [];
    if (promptInputs) {
        for (const [k, v] of Object.entries(promptInputs)) {
            if (v === null || typeof v !== "object") lines.push(`${k}: ${v}`); // skip [nodeId, slot] links
        }
    } else if (Array.isArray(node.widgets_values)) {
        for (const v of node.widgets_values) {
            if (v === null || typeof v !== "object") lines.push(String(v));
        }
    }
    return lines;
}

export function WorkflowGraph({ workflow, prompt, missing }: { workflow: string; prompt?: string; missing?: string[]; }) {
    const data = useMemo(() => { try { return JSON.parse(workflow); } catch { return null; } }, [workflow]);
    const missingSet = useMemo(() => new Set(missing ?? []), [missing]);
    const promptMap = useMemo<Record<string, any>>(() => {
        if (!prompt) return {};
        try { return JSON.parse(prompt); } catch { return {}; }
    }, [prompt]);
    const svgRef = useRef<SVGSVGElement>(null);
    const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
    const drag = useRef<{ sx: number; sy: number; x: number; y: number; } | null>(null);
    const fitted = useRef(false);

    const layout = useMemo(() => {
        if (!data?.nodes?.length) return null;
        const nodes = data.nodes.map((n: any) => {
            const { x, y } = getPos(n);
            const { w, h } = getSize(n);
            return { n, x, y, w, h };
        });
        const byId = new Map<any, any>(nodes.map((L: any) => [L.n.id, L]));

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const L of nodes) {
            minX = Math.min(minX, L.x); minY = Math.min(minY, L.y);
            maxX = Math.max(maxX, L.x + L.w); maxY = Math.max(maxY, L.y + L.h);
        }

        const links: { x1: number; y1: number; x2: number; y2: number; }[] = [];
        for (const lk of (data.links ?? [])) {
            let origin: any, originSlot: any, target: any, targetSlot: any;
            if (Array.isArray(lk)) { [, origin, originSlot, target, targetSlot] = lk; }
            else if (lk && typeof lk === "object") {
                origin = lk.origin_id; originSlot = lk.origin_slot;
                target = lk.target_id; targetSlot = lk.target_slot;
            }
            const a = byId.get(origin); const b = byId.get(target);
            if (!a || !b) continue;
            links.push({
                x1: a.x + a.w, y1: a.y + TITLE_H + (num(originSlot) + 0.5) * SLOT_H,
                x2: b.x, y2: b.y + TITLE_H + (num(targetSlot) + 0.5) * SLOT_H
            });
        }
        return { nodes, links, minX, minY, w: maxX - minX, h: maxY - minY };
    }, [data]);

    // map world point so it stays under the screen point (sx,sy) at new scale k
    const zoomAround = useCallback((sx: number, sy: number, factor: number) => {
        setView(v => {
            const k = clamp(v.k * factor);
            const wx = (sx - v.x) / v.k;
            const wy = (sy - v.y) / v.k;
            return { k, x: sx - wx * k, y: sy - wy * k };
        });
    }, []);

    const fit = useCallback(() => {
        const svg = svgRef.current;
        if (!svg || !layout) return;
        const W = svg.clientWidth || 800;
        const H = svg.clientHeight || 500;
        const k = clamp(Math.min(W / layout.w, H / layout.h) * 0.92);
        const x = (W - layout.w * k) / 2 - layout.minX * k;
        const y = (H - layout.h * k) / 2 - layout.minY * k;
        setView({ k, x, y });
    }, [layout]);

    const zoomCenter = useCallback((factor: number) => {
        const svg = svgRef.current;
        if (!svg) return;
        zoomAround(svg.clientWidth / 2, svg.clientHeight / 2, factor);
    }, [zoomAround]);

    // auto-fit once the svg actually has a size (it may be 0 while the modal animates in)
    useLayoutEffect(() => { fitted.current = false; }, [layout]);
    useEffect(() => {
        const svg = svgRef.current;
        if (!svg) return;
        const tryFit = () => {
            if (!fitted.current && svg.clientWidth > 0 && svg.clientHeight > 0) { fit(); fitted.current = true; }
        };
        tryFit();
        const ro = new ResizeObserver(tryFit);
        ro.observe(svg);
        return () => ro.disconnect();
    }, [fit]);

    // non-passive wheel listener so we can preventDefault and zoom to the cursor
    useEffect(() => {
        const svg = svgRef.current;
        if (!svg) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = svg.getBoundingClientRect();
            zoomAround(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
        };
        svg.addEventListener("wheel", onWheel, { passive: false });
        return () => svg.removeEventListener("wheel", onWheel);
    }, [zoomAround]);

    if (!layout) return <div className="cwg-empty">No editor graph embedded (only the API graph is present).</div>;

    const onDown = (e: React.MouseEvent) => { drag.current = { sx: e.clientX, sy: e.clientY, x: view.x, y: view.y }; };
    const onMove = (e: React.MouseEvent) => {
        const d = drag.current;
        if (!d) return;
        setView(v => ({ ...v, x: d.x + (e.clientX - d.sx), y: d.y + (e.clientY - d.sy) }));
    };
    const onUp = () => { drag.current = null; };

    return (
        <div className="cwg-graph">
            <div className="cwg-graph-toolbar">
                <button onClick={fit}>Fit</button>
                <button onClick={() => zoomCenter(1.3)}>＋</button>
                <button onClick={() => zoomCenter(1 / 1.3)}>－</button>
                <span>{Math.round(view.k * 100)}%</span>
                <span className="cwg-graph-hint">scroll = zoom to cursor · drag = pan · Fit = reset</span>
            </div>
            <svg
                ref={svgRef}
                className="cwg-graph-svg"
                onMouseDown={onDown}
                onMouseMove={onMove}
                onMouseUp={onUp}
                onMouseLeave={onUp}
            >
                <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                    {layout.links.map((l, i) => {
                        const dx = Math.max(40, Math.abs(l.x2 - l.x1) * 0.5);
                        return <path key={i} className="cwg-link" d={`M ${l.x1} ${l.y1} C ${l.x1 + dx} ${l.y1}, ${l.x2 - dx} ${l.y2}, ${l.x2} ${l.y2}`} />;
                    })}
                    {layout.nodes.map((L: any, i: number) => {
                        const title = String(L.n.title || L.n.type || "node");
                        const inN = L.n.inputs?.length ?? 0;
                        const lines = bodyLines(L.n, promptMap[String(L.n.id)]?.inputs);
                        const bodyTop = L.y + TITLE_H + inN * SLOT_H + 6;
                        const maxLines = Math.max(0, Math.floor((L.y + L.h - bodyTop - 2) / WIDGET_H));
                        const shown = lines.slice(0, maxLines);
                        const hidden = lines.length - shown.length;
                        const isMissing = missingSet.has(String(L.n.type));
                        return (
                            <g key={i}>
                                <rect className={isMissing ? "cwg-node cwg-node-missing" : "cwg-node"} x={L.x} y={L.y} width={L.w} height={L.h} rx={8}
                                    style={L.n.bgcolor ? { fill: L.n.bgcolor } : undefined} />
                                <path className="cwg-node-title" d={titleBarPath(L.x, L.y, L.w)}
                                    style={isMissing ? { fill: "#6e1f1f" } : (L.n.color ? { fill: L.n.color } : undefined)} />
                                <text className="cwg-node-text" x={L.x + 10} y={L.y + 20}>{trunc(title, L.w)}</text>
                                {isMissing && <text className="cwg-node-missing-tag" x={L.x + L.w - 8} y={L.y + 20}>missing</text>}
                                {shown.map((line, li) => (
                                    <text key={"w" + li} className="cwg-widget" x={L.x + 10} y={bodyTop + li * WIDGET_H + 11}>
                                        {trunc(line, L.w - 12)}
                                    </text>
                                ))}
                                {hidden > 0 && (
                                    <text className="cwg-widget cwg-widget-more" x={L.x + 10} y={bodyTop + shown.length * WIDGET_H + 11}>+{hidden} more…</text>
                                )}
                                {(L.n.inputs ?? []).map((inp: any, si: number) => (
                                    <g key={"i" + si}>
                                        <circle className="cwg-slot" cx={L.x} cy={L.y + TITLE_H + (si + 0.5) * SLOT_H} r={3.5} />
                                        {inp?.name && <text className="cwg-slot-label cwg-slot-in" x={L.x + 8} y={L.y + TITLE_H + (si + 0.5) * SLOT_H + 4}>{trunc(String(inp.name), L.w / 2)}</text>}
                                    </g>
                                ))}
                                {(L.n.outputs ?? []).map((out: any, si: number) => (
                                    <g key={"o" + si}>
                                        <circle className="cwg-slot" cx={L.x + L.w} cy={L.y + TITLE_H + (si + 0.5) * SLOT_H} r={3.5} />
                                        {out?.name && <text className="cwg-slot-label cwg-slot-out" x={L.x + L.w - 8} y={L.y + TITLE_H + (si + 0.5) * SLOT_H + 4}>{trunc(String(out.name), L.w / 2)}</text>}
                                    </g>
                                ))}
                            </g>
                        );
                    })}
                </g>
            </svg>
        </div>
    );
}

// rounded top corners only, square bottom (sits flush on the node body)
function titleBarPath(x: number, y: number, w: number) {
    const r = 8;
    return `M ${x} ${y + TITLE_H} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} L ${x + w} ${y + TITLE_H} Z`;
}
