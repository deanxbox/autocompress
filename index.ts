/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import {
    DraftType,
    SelectedChannelStore,
    showToast,
    Toasts,
    UploadManager,
} from "@webpack/common";

type ProcessResult =
    | { success: true; file: File; originalSizeMB: number; sizeMB: number; encoderUsed: string; }
    | { success: false; fileName: string; error: string; cancelled?: true; };

const Native = VencordNative.pluginHelpers.AutoCompress as PluginNative<
    typeof import("./native")
>;

const FORMATS = new Set([
    "video/mp4",
    "video/quicktime",
    "video/x-msvideo",
    "video/x-matroska",
    "video/webm",
    "audio/mpeg",
    "audio/wav",
    "audio/flac",
]);

const CHUNK_SIZE = 4 * 1024 * 1024;

const settings = definePluginSettings({
    ffmpegTimeout: {
        type: OptionType.NUMBER,
        description: "Duration per file before compression is aborted [seconds]",
        default: 120,
    },
    ffmpegPath: {
        type: OptionType.STRING,
        description: "Path to ffmpeg binary (empty will attempt to resolve automatically)",
        default: "",
    },
    ffprobePath: {
        type: OptionType.STRING,
        description: "Path to ffprobe binary (empty will attempt to resolve automatically)",
        default: "",
    },
    compressionTarget: {
        type: OptionType.NUMBER,
        description: "File size to target with compression [MB]",
        default: 9,
    },
    compressionThreshold: {
        type: OptionType.NUMBER,
        description: "Maximum file size before compression is used [MB]",
        default: 10,
    },
    compressionPreset: {
        type: OptionType.SELECT,
        description: "Encoding speed (slower results in better quality at the same size)",
        options: [
            { label: "Fastest", value: "ultrafast" },
            { label: "Fast", value: "fast" },
            { label: "Medium (Balanced)", value: "medium", default: true },
            { label: "Slow", value: "slow" },
            { label: "Very Slow", value: "veryslow" },
        ],
    },
    maxResolution: {
        type: OptionType.SELECT,
        description: "Maximum resolution (downscaling MAY result in better quality with low bitrates)",
        options: [
            { label: "Keep Original", value: "original", default: true },
            { label: "1080p", value: "1080" },
            { label: "720p", value: "720" },
            { label: "480p", value: "480" },
        ],
    },
});

const OVERLAY_ID = "autocompress-progress-overlay";

interface ProgressEstimate {
    startedAt: number;
    lastPercent: number;
}

const progressEstimates = new Map<string, ProgressEstimate>();

function getOrCreateOverlay(): HTMLElement {
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
        el = document.createElement("div");
        el.id = OVERLAY_ID;
        Object.assign(el.style, {
            position: "fixed",
            bottom: "60px",
            right: "16px",
            zIndex: "9999",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            pointerEvents: "none",
        });
        document.body.appendChild(el);
    }
    return el;
}

function createProgressCard(jobId: string, fileName: string, onCancel: () => void): HTMLElement {
    const card = document.createElement("div");
    card.dataset.jobId = jobId;
    Object.assign(card.style, {
        background: "var(--background-floating, #18191c)",
        border: "1px solid var(--background-modifier-accent, #4f545c)",
        borderRadius: "8px",
        padding: "10px 12px",
        minWidth: "260px",
        maxWidth: "320px",
        pointerEvents: "all",
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "6px",
    });

    const label = document.createElement("span");
    label.style.cssText = "font-size:13px;font-weight:600;color:var(--header-primary,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;";
    label.title = fileName;
    label.textContent = fileName;

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "✕";
    Object.assign(cancelBtn.style, {
        background: "none",
        border: "none",
        color: "var(--interactive-normal, #b9bbbe)",
        cursor: "pointer",
        fontSize: "14px",
        padding: "0 0 0 8px",
        lineHeight: "1",
    });
    cancelBtn.title = "Cancel compression";
    cancelBtn.onclick = () => {
        onCancel();
        cancelBtn.disabled = true;
        cancelBtn.textContent = "...";
        cancelBtn.style.cursor = "default";
    };

    header.appendChild(label);
    header.appendChild(cancelBtn);

    const track = document.createElement("div");
    Object.assign(track.style, {
        background: "var(--background-modifier-accent, #4f545c)",
        borderRadius: "3px",
        height: "6px",
        overflow: "hidden",
    });

    const fill = document.createElement("div");
    fill.dataset.fill = "1";
    Object.assign(fill.style, {
        height: "100%",
        width: "0%",
        background: "var(--brand-experiment, #5865f2)",
        borderRadius: "3px",
        transition: "width 0.3s ease",
    });

    const pctLabel = document.createElement("div");
    pctLabel.dataset.pct = "1";
    pctLabel.style.cssText = "font-size:11px;color:var(--text-muted,#72767d);margin-top:4px;";
    pctLabel.textContent = "0%";

    track.appendChild(fill);
    card.appendChild(header);
    card.appendChild(track);
    card.appendChild(pctLabel);

    getOrCreateOverlay().appendChild(card);
    return card;
}

function formatSize(sizeMB: number): string {
    return sizeMB >= 100
        ? `${Math.round(sizeMB)} MB`
        : `${sizeMB.toFixed(1)} MB`;
}

function formatPercentChange(originalSizeMB: number, sizeMB: number): string {
    if (originalSizeMB <= 0) return "0%";

    const change = ((sizeMB - originalSizeMB) / originalSizeMB) * 100;
    return `${change > 0 ? "+" : ""}${change.toFixed(1)}%`;
}

function formatEta(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 1) return "<1s";

    const rounded = Math.ceil(seconds);
    const minutes = Math.floor(rounded / 60);
    const remainingSeconds = rounded % 60;

    if (minutes === 0) return `${remainingSeconds}s`;
    if (minutes < 60) return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;

    const hours = Math.floor(minutes / 60);
    return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

function formatProgressStatus(jobId: string, percent: number): string {
    const now = Date.now();
    const clamped = Math.max(0, Math.min(100, percent));
    const current = progressEstimates.get(jobId);

    if (!current || clamped <= 0 || clamped < current.lastPercent) {
        progressEstimates.set(jobId, { startedAt: now, lastPercent: clamped });
        return `${clamped}%`;
    }

    current.lastPercent = clamped;

    if (clamped >= 100) return "100%";

    const elapsedSeconds = (now - current.startedAt) / 1000;
    const etaSeconds = (elapsedSeconds / clamped) * (100 - clamped);
    return `${clamped}% - ETA ${formatEta(etaSeconds)}`;
}

function updateProgressCard(jobId: string, percent: number, status?: string) {
    const card = document.querySelector(`[data-job-id="${jobId}"]`) as HTMLElement | null;
    if (!card) return;
    const fill = card.querySelector("[data-fill]") as HTMLElement | null;
    const pct = card.querySelector("[data-pct]") as HTMLElement | null;
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (pct) pct.textContent = status ?? `${Math.max(0, Math.min(100, percent))}%`;
}

function removeProgressCard(jobId: string) {
    const card = document.querySelector(`[data-job-id="${jobId}"]`);
    card?.remove();
    progressEstimates.delete(jobId);
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay && overlay.childElementCount === 0) overlay.remove();
}

function isValid(files: FileList | undefined): files is FileList {
    return files !== undefined && files.length > 0;
}

function makeCancelledError(): Error & { cancelled: true; } {
    const err = new Error("cancelled") as Error & { cancelled: true; };
    err.cancelled = true;
    return err;
}

function createUploadCancelCard(channelId: string, fileCount: number) {
    const jobId = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    createProgressCard(jobId, `${fileCount} pending upload${fileCount === 1 ? "" : "s"}`, () => {
        UploadManager.clearAll(channelId, DraftType.ChannelMessage);
        showToast("Upload cancelled", Toasts.Type.MESSAGE);
        removeProgressCard(jobId);
    });
    updateProgressCard(jobId, 100, "Ready to upload");

    setTimeout(() => removeProgressCard(jobId), 30_000);
}

let validationCache: { ffmpegPath: string; ffprobePath: string; encoder: string; } | null = null;

async function validateBinaries(): Promise<boolean> {
    const ffmpegPath = settings.store.ffmpegPath?.trim() ?? "";
    const ffprobePath = settings.store.ffprobePath?.trim() ?? "";

    if (
        validationCache
        && validationCache.ffmpegPath === ffmpegPath
        && validationCache.ffprobePath === ffprobePath
    ) {
        return true;
    }

    const validated = await Native.testBinaries(ffmpegPath || undefined, ffprobePath || undefined);
    if (!validated.success) {
        showNotification({
            title: "AutoCompress",
            body: `Failed validation: ${validated.error}`,
            color: "#f04747",
            noPersist: false,
        });
        return false;
    }

    const encoder = validated.encoder ?? "unknown encoder";
    validationCache = { ffmpegPath, ffprobePath, encoder };
    showToast(`AutoCompress ready - using ${encoder}`, Toasts.Type.SUCCESS);
    return true;
}

async function hookPaste(event: ClipboardEvent) {
    const files = event.clipboardData?.files;
    if (!isValid(files) || !(await validateBinaries())) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    await handleFiles(files);
}

async function hookDrop(event: DragEvent) {
    const files = event.dataTransfer?.files;
    if (!isValid(files) || !(await validateBinaries())) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    await handleFiles(files);
}

function hookDrag(event: DragEvent) {
    const types = event.dataTransfer?.types;
    if (types?.includes("Files")) {
        event.preventDefault();
        event.stopPropagation();
    }
}

async function handleFiles(files: FileList) {
    const allFiles = Array.from(files);
    const compressibleFiles: File[] = [];
    const otherFiles: File[] = [];

    for (const file of allFiles) {
        const sizeMB = file.size / (1024 * 1024);
        if (FORMATS.has(file.type) && sizeMB > settings.store.compressionThreshold) {
            compressibleFiles.push(file);
        } else {
            otherFiles.push(file);
        }
    }

    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return;

    if (compressibleFiles.length === 0) {
        if (otherFiles.length > 0) {
            UploadManager.addFiles({
                channelId,
                draftType: DraftType.ChannelMessage,
                files: otherFiles.map(file => ({ file, platform: 1 })),
                showLargeMessageDialog: false,
            });
            createUploadCancelCard(channelId, otherFiles.length);
        }
        return;
    }

    const results = await Promise.all(compressibleFiles.map(file => processFile(file)));

    const successful = results.filter((r): r is Extract<ProcessResult, { success: true; }> => r.success);
    const cancelled = results.filter((r): r is Extract<ProcessResult, { success: false; cancelled: true; }> => !r.success && !!r.cancelled);
    const failed = results.filter((r): r is Extract<ProcessResult, { success: false; }> => !r.success && !r.cancelled);
    const toUpload = [...successful.map(r => r.file), ...otherFiles];

    if (cancelled.length === results.length) {
        showToast("Compression cancelled", Toasts.Type.MESSAGE);
        return;
    }

    const messageParts = [
        `Compressed ${successful.length}/${results.length} file(s)`,
        failed.length > 0 ? `Failed: ${failed.map(f => `${f.fileName} (${f.error})`).join(", ")}` : "",
        cancelled.length > 0 ? `Cancelled: ${cancelled.length}` : "",
        successful.length > 0 ? `Encoder: ${Array.from(new Set(successful.map(r => r.encoderUsed))).join(", ")}` : "",
        successful.length > 0
            ? `Changes:\n${successful.map(r => `${r.file.name}: ${formatSize(r.originalSizeMB)} -> ${formatSize(r.sizeMB)} (${formatPercentChange(r.originalSizeMB, r.sizeMB)})`).join("\n")}`
            : "",
    ].filter(Boolean);

    if (toUpload.length > 0) {
        UploadManager.addFiles({
            channelId,
            draftType: DraftType.ChannelMessage,
            files: toUpload.map(file => ({ file, platform: 1 })),
            showLargeMessageDialog: false,
        });
        createUploadCancelCard(channelId, toUpload.length);
    }

    showNotification({
        title: "AutoCompress",
        body: messageParts.join("\n"),
        color: failed.length === 0 ? "#43b581" : successful.length === 0 ? "#f04747" : "#faa61a",
        noPersist: false,
    });
}

async function resolveInputPath(
    file: File,
    jobId: string,
    shouldCancel: () => boolean,
): Promise<{ inputPath: string; isTemp: boolean; }> {
    const nativePath = (file as { path?: string; }).path;
    if (nativePath && nativePath.length > 0) return { inputPath: nativePath, isTemp: false };

    showToast(`Staging ${file.name} for compression...`, Toasts.Type.MESSAGE);
    updateProgressCard(jobId, 0, "Staging file...");
    const tempPath = await Native.openTempFile(file.name);
    const reader = file.stream().getReader();
    let written = 0;

    try {
        while (true) {
            if (shouldCancel()) {
                await reader.cancel().catch(() => {});
                throw makeCancelledError();
            }

            const { done, value } = await reader.read();
            if (done) break;
            let offset = 0;
            while (offset < value.byteLength) {
                if (shouldCancel()) throw makeCancelledError();
                const chunk = value.subarray(offset, offset + CHUNK_SIZE);
                await Native.writeChunk(tempPath, chunk);
                offset += chunk.byteLength;
                written += chunk.byteLength;
                updateProgressCard(jobId, Math.floor((written / file.size) * 100), "Staging file...");
            }
        }
    } catch (err) {
        await Native.closeTempFile(tempPath).catch(() => {});
        throw err;
    } finally {
        reader.releaseLock();
    }

    await Native.closeTempFile(tempPath);
    return { inputPath: tempPath, isTemp: true };
}

async function processFile(file: File): Promise<ProcessResult> {
    let inputPath: string | undefined;
    let inputIsTemp = false;
    let outPath: string | undefined;
    let pollInterval: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    createProgressCard(jobId, file.name, () => {
        cancelled = true;
        updateProgressCard(jobId, 0, "Cancelling...");
        void Native.cancelJob(jobId);
    });

    try {
        ({ inputPath, isTemp: inputIsTemp } = await resolveInputPath(file, jobId, () => cancelled));
        if (cancelled) throw makeCancelledError();

        pollInterval = setInterval(async () => {
            try {
                const percent = await Native.getProgress(jobId);
                if (percent !== null) updateProgressCard(jobId, percent, formatProgressStatus(jobId, percent));
            } catch {
                // Ignore polling errors during teardown/cancellation.
            }
        }, 250);

        const res = await Native.handleFile(
            jobId,
            inputPath,
            file.name,
            file.type,
            settings.store.compressionTarget,
            settings.store.compressionPreset,
            settings.store.maxResolution,
            settings.store.ffmpegTimeout * 1000,
        );

        if (!res.success) {
            if (res.cancelled) {
                return { success: false, fileName: file.name, error: "cancelled", cancelled: true };
            }

            return { success: false, fileName: file.name, error: res.error };
        }

        outPath = res.outPath;
        const bytes = await Native.readFileBytes(outPath);
        const compressedFile = new File([bytes], file.name, { type: file.type });
        return {
            success: true,
            file: compressedFile,
            originalSizeMB: file.size / (1024 * 1024),
            sizeMB: bytes.byteLength / (1024 * 1024),
            encoderUsed: res.encoderUsed,
        };
    } catch (err) {
        if ((err as { cancelled?: boolean; })?.cancelled) {
            return { success: false, fileName: file.name, error: "cancelled", cancelled: true };
        }

        return {
            success: false,
            fileName: file.name,
            error: err instanceof Error ? err.message : String(err),
        };
    } finally {
        if (pollInterval) clearInterval(pollInterval);
        removeProgressCard(jobId);
        await Native.clearProgress(jobId).catch(() => {});
        if (outPath) await Native.cleanupFile(outPath).catch(() => {});
        if (inputIsTemp && inputPath) await Native.cleanupFile(inputPath).catch(() => {});
    }
}

export default definePlugin({
    name: "AutoCompress",
    description: "Automatically compress videos/audio to reach a target size",
    authors: [{ name: "dyn", id: 262458273247002636n }],
    settings,

    start() {
        document.addEventListener("drop", hookDrop, { capture: true });
        document.addEventListener("dragover", hookDrag, { capture: true });
        document.addEventListener("paste", hookPaste, { capture: true });
    },

    stop() {
        document.removeEventListener("drop", hookDrop, { capture: true });
        document.removeEventListener("dragover", hookDrag, { capture: true });
        document.removeEventListener("paste", hookPaste, { capture: true });
        document.getElementById(OVERLAY_ID)?.remove();
        validationCache = null;
    },
});
