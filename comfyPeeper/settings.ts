/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    badgeMode: {
        type: OptionType.SELECT,
        description: "Where to show the workflow badge",
        options: [
            { label: "Overlay on the image (falls back to below if it can't attach)", value: "overlay", default: true },
            { label: "Below the message", value: "below" },
            { label: "Both", value: "both" }
        ]
    },
    endpoints: {
        type: OptionType.STRING,
        default: "Local = http://127.0.0.1:8188",
        description:
            "ComfyUI endpoints, comma-separated. Optionally prefix with a label, e.g. " +
            "\"Local = http://127.0.0.1:8188, Remote = https://gpu.example.com:8188\". " +
            "A Queue button is shown per endpoint."
    },
    autoScan: {
        type: OptionType.BOOLEAN,
        default: true,
        description:
            "Automatically scan attachments (PNG/WebP/MP4) for workflows. " +
            "If off, a small \"Check workflow\" button is shown instead (saves bandwidth)."
    },
    maxSizeMB: {
        type: OptionType.NUMBER,
        default: 40,
        description: "Skip files larger than this many MB when scanning (videos read only the metadata atom)."
    }
});
