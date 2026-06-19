/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IconComponent } from "@utils/types";
import { React } from "@webpack/common";

// NOTE: never build JSX at module scope — React isn't ready when plugins load and it
// throws during init (taking down all of Vencord). Keep JSX inside the components.

/** Node-graph / "workflow" glyph (two connected nodes) — ComfyPeeper's identity mark. */
export function NodeIcon({ size = 16 }: { size?: number; }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0, display: "block" }}
            aria-hidden="true"
        >
            <rect x="3" y="3" width="8" height="8" rx="2" />
            <path d="M7 11v4a2 2 0 0 0 2 2h4" />
            <rect x="13" y="13" width="8" height="8" rx="2" />
        </svg>
    );
}

/** Same glyph in Vencord's IconComponent shape (e.g. for chat-bar/toolbar icons). */
export const NodeIconComponent: IconComponent = ({ width = 24, height = 24, className }) => (
    <svg
        width={width}
        height={height}
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        <rect x="3" y="3" width="8" height="8" rx="2" />
        <path d="M7 11v4a2 2 0 0 0 2 2h4" />
        <rect x="13" y="13" width="8" height="8" rx="2" />
    </svg>
);
