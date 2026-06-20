/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";
import { Button, React } from "@webpack/common";

import { openLibraryModal } from "./LibraryModal";

export const settings = definePluginSettings({
    openLibrary: {
        type: OptionType.COMPONENT,
        description: "Saved workflows library",
        component: () => (
            <Button onClick={() => openLibraryModal()}>📚 Open saved workflows library</Button>
        )
    },
    advancedMode: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Advanced mode: add a LoRAs tab to the previewer that checks a workflow's LoRAs against your ComfyUI server(s) and helps download missing ones (via ComfyUI-Lora-Manager when installed, plus Civitai/CivArchive search links)."
    },
    yoink: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Yoink"
    },
    attachWorkflowOnUpload: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "When you upload a video that has an embedded ComfyUI workflow, attach it as a .json sidecar (Discord often strips video metadata, so this lets it survive for everyone)."
    },
    attachMode: {
        type: OptionType.SELECT,
        description: "How to attach the workflow .json on upload",
        options: [
            { label: "Ask each time", value: "ask", default: true },
            { label: "Attach automatically (no prompt)", value: "auto" }
        ]
    },
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
