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
    React,
    Select,
    SelectedChannelStore,
    showToast,
    Text,
    TextInput,
    Toasts,
    UploadAttachmentStore,
    UploadManager,
    useState,
} from "@webpack/common";

type ProcessResult =
    | { success: true; file: File; originalFileName: string; originalSizeMB: number; sizeMB: number; encoderUsed: string; output: "compressed" | "original"; note?: string; }
    | { success: false; file: File; fileName: string; error: string; cancelled?: true; };

const Native = VencordNative.pluginHelpers.AutoCompress as PluginNative<
    typeof import("./native")
>;

const MEDIA_FORMATS = new Set([
    "video/mp4",
    "video/quicktime",
    "video/x-msvideo",
    "video/x-matroska",
    "video/webm",
    "audio/mpeg",
    "audio/wav",
    "audio/flac",
]);

const IMAGE_FORMATS = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
]);

const CHUNK_SIZE = 4 * 1024 * 1024;
const DUPLICATE_BATCH_MS = 1500;

type CompressionKind = "media" | "image";
type CompressionMode = "auto" | "media" | "image" | "off";
type FailedFileBehavior = "upload-original" | "skip";
type SizeUnit = "KB" | "MB" | "GB";
type SizeSetting = number | { value: number; unit: SizeUnit; };

const SIZE_UNIT_BYTES: Record<SizeUnit, number> = {
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
};

const SIZE_UNIT_OPTIONS = [
    { label: "KB", value: "KB" },
    { label: "MB", value: "MB" },
    { label: "GB", value: "GB" },
];

const COMPRESSION_MODE_OPTIONS = [
    { label: "Auto (Videos, Audio, Images)", value: "auto", default: true },
    { label: "Videos + Audio Only", value: "media" },
    { label: "Images Only", value: "image" },
    { label: "Off", value: "off" },
];

const FAILED_FILE_BEHAVIOR_OPTIONS = [
    { label: "Skip failed file", value: "skip", default: true },
    { label: "Upload original", value: "upload-original" },
];

function debugLog(message: string, ...args: unknown[]) {
    if (settings.store.debugLogging) {
        console.log(`[AutoCompress] ${message}`, ...args);
    }
}

function normalizeSizeSetting(raw: unknown, fallbackValue: number, fallbackUnit: SizeUnit): { value: number; unit: SizeUnit; } {
    if (typeof raw === "object" && raw !== null) {
        const maybeSetting = raw as { value?: unknown; unit?: unknown; };
        const value = typeof maybeSetting.value === "number" && Number.isFinite(maybeSetting.value)
            ? maybeSetting.value
            : fallbackValue;
        return { value, unit: getSizeUnit(maybeSetting.unit) };
    }

    if (typeof raw === "number" && Number.isFinite(raw)) {
        return { value: raw, unit: fallbackUnit };
    }

    return { value: fallbackValue, unit: fallbackUnit };
}

function formatSettingValue(value: number): string {
    if (!Number.isFinite(value)) return "0";

    return String(Math.round(value * 1000) / 1000);
}

function convertSizeValue(value: number, fromUnit: SizeUnit, toUnit: SizeUnit): number {
    return (value * SIZE_UNIT_BYTES[fromUnit]) / SIZE_UNIT_BYTES[toUnit];
}

function SizeSettingControl({
    label,
    description,
    defaultValue,
    settingKey,
    setValue,
}: {
    label: string;
    description: string;
    defaultValue: number;
    settingKey: "compressionTarget" | "compressionThreshold";
    setValue(newValue: SizeSetting): void;
}) {
    const legacyUnit = getSizeUnit((settings.store as Record<string, unknown>)[`${settingKey}Unit`]);
    const initial = normalizeSizeSetting(settings.store[settingKey], defaultValue, legacyUnit);
    const [value, setLocalValue] = useState(formatSettingValue(initial.value));
    const [unit, setLocalUnit] = useState<SizeUnit>(initial.unit);

    function commit(nextValue: string, nextUnit: SizeUnit) {
        const parsed = Number(nextValue);
        if (!Number.isFinite(parsed)) return;

        setValue({ value: Math.max(0, parsed), unit: nextUnit });
    }

    function handleValueChange(nextValue: string) {
        setLocalValue(nextValue);
        commit(nextValue, unit);
    }

    function handleUnitChange(nextUnit: SizeUnit) {
        const parsed = Number(value);
        const converted = Number.isFinite(parsed)
            ? formatSettingValue(convertSizeValue(parsed, unit, nextUnit))
            : value;

        setLocalUnit(nextUnit);
        setLocalValue(converted);
        commit(converted, nextUnit);
    }

    return React.createElement(
        "div",
        { style: { marginBottom: "20px" } },
        React.createElement(
            "div",
            { style: { marginBottom: "8px" } },
            React.createElement(Text, { variant: "text-md/medium" }, label),
            React.createElement(Text, { color: "text-muted", variant: "text-sm/normal" }, description),
        ),
        React.createElement(
            "div",
            { style: { display: "flex", gap: "8px", alignItems: "center" } },
            React.createElement(TextInput, {
                type: "number",
                value,
                min: 0,
                step: "any",
                onChange: handleValueChange,
                style: { flex: "1 1 auto" },
            }),
            React.createElement(
                "div",
                { style: { flex: "0 0 96px" } },
                React.createElement(Select, {
                    options: SIZE_UNIT_OPTIONS,
                    maxVisibleItems: 3,
                    closeOnSelect: true,
                    select: handleUnitChange,
                    isSelected: (selected: SizeUnit) => selected === unit,
                    serialize: String,
                }),
            ),
        ),
    );
}

function DiagnosticsControl() {
    const [isRunning, setIsRunning] = useState(false);

    async function runDiagnostics() {
        if (isRunning) return;

        setIsRunning(true);
        try {
            const ffmpegPath = settings.store.ffmpegPath?.trim() || undefined;
            const ffprobePath = settings.store.ffprobePath?.trim() || undefined;
            const validation = await Native.testBinaries(ffmpegPath, ffprobePath);
            const diagnostics = await Native.getDiagnostics();
            const payload = {
                validation,
                settings: {
                    compressionMode: settings.store.compressionMode,
                    compressionTarget: settings.store.compressionTarget,
                    compressionThreshold: settings.store.compressionThreshold,
                    compressionPreset: settings.store.compressionPreset,
                    maxResolution: settings.store.maxResolution,
                    maxWidth: settings.store.maxWidth,
                    maxHeight: settings.store.maxHeight,
                    concurrentJobs: settings.store.concurrentJobs,
                    useHardwareDecode: settings.store.useHardwareDecode,
                    debugLogging: settings.store.debugLogging,
                },
                diagnostics,
            };
            const text = JSON.stringify(payload, null, 2);

            console.log("[AutoCompress] Diagnostics", payload);
            await navigator.clipboard.writeText(text).catch(() => undefined);

            showNotification({
                title: "AutoCompress",
                body: validation.success
                    ? `Diagnostics copied. Encoder: ${validation.encoder ?? "unknown"}`
                    : `Diagnostics copied. Validation failed: ${validation.error}`,
                color: validation.success ? "#43b581" : "#faa61a",
                noPersist: false,
            });
        } catch (err) {
            showNotification({
                title: "AutoCompress",
                body: `Diagnostics failed: ${err instanceof Error ? err.message : String(err)}`,
                color: "#f04747",
                noPersist: false,
            });
        } finally {
            setIsRunning(false);
        }
    }

    return React.createElement(
        "div",
        { style: { marginBottom: "20px" } },
        React.createElement(
            "div",
            { style: { marginBottom: "8px" } },
            React.createElement(Text, { variant: "text-md/medium" }, "Diagnostics"),
            React.createElement(Text, { color: "text-muted", variant: "text-sm/normal" }, "Test ffmpeg/GPU support and copy a report to the clipboard"),
        ),
        React.createElement(
            "button",
            {
                disabled: isRunning,
                onClick: runDiagnostics,
                style: {
                    background: "var(--brand-experiment, #5865f2)",
                    border: "none",
                    borderRadius: "4px",
                    color: "#fff",
                    cursor: isRunning ? "default" : "pointer",
                    fontSize: "14px",
                    fontWeight: 600,
                    padding: "8px 12px",
                    opacity: isRunning ? 0.7 : 1,
                },
            },
            isRunning ? "Running..." : "Run Diagnostics",
        ),
    );
}

const settings = definePluginSettings({
    compressionMode: {
        type: OptionType.SELECT,
        description: "Which attachment types AutoCompress should intercept",
        options: COMPRESSION_MODE_OPTIONS,
    },
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
        type: OptionType.COMPONENT,
        default: { value: 9, unit: "MB" },
        component: props => React.createElement(SizeSettingControl, {
            label: "Compression Target",
            description: "File size to target with compression",
            defaultValue: 9,
            settingKey: "compressionTarget",
            setValue: props.setValue,
        }),
    },
    compressionThreshold: {
        type: OptionType.COMPONENT,
        default: { value: 10, unit: "MB" },
        component: props => React.createElement(SizeSettingControl, {
            label: "Compression Threshold",
            description: "Maximum file size before compression is used",
            defaultValue: 10,
            settingKey: "compressionThreshold",
            setValue: props.setValue,
        }),
    },
    useOriginalIfWorse: {
        type: OptionType.BOOLEAN,
        description: "Upload the original file if compression makes it larger",
        default: false,
    },
    uploadIfSmaller: {
        type: OptionType.BOOLEAN,
        description: "Upload the compressed file even if it exceeds the target, as long as it is smaller than the original",
        default: false,
    },
    failedFileBehavior: {
        type: OptionType.SELECT,
        description: "What to do when an individual file fails compression",
        options: FAILED_FILE_BEHAVIOR_OPTIONS,
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
    maxWidth: {
        type: OptionType.NUMBER,
        description: "Optional custom maximum width in pixels (0 uses the preset above)",
        default: 0,
    },
    maxHeight: {
        type: OptionType.NUMBER,
        description: "Optional custom maximum height in pixels (0 uses the preset above)",
        default: 0,
    },
    concurrentJobs: {
        type: OptionType.NUMBER,
        description: "Maximum files to compress at once (higher can use more GPU, but may make Discord less responsive)",
        default: 2,
    },
    useHardwareDecode: {
        type: OptionType.BOOLEAN,
        description: "Use GPU decoding when ffmpeg can do so safely",
        default: true,
    },
    debugLogging: {
        type: OptionType.BOOLEAN,
        description: "Log AutoCompress pipeline details to the console",
        default: false,
    },
    diagnostics: {
        type: OptionType.COMPONENT,
        component: DiagnosticsControl,
    },
});

const OVERLAY_ID = "autocompress-progress-overlay";

interface ProgressEstimate {
    startedAt: number;
    lastPercent: number;
}

const progressEstimates = new Map<string, ProgressEstimate>();
const uploadWatchers = new Map<string, ReturnType<typeof setInterval>>();

function getOrCreateOverlay(): HTMLElement {
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
        el = document.createElement("div");
        el.id = OVERLAY_ID;
        Object.assign(el.style, {
            position: "fixed",
            top: "16px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: "9999",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            alignItems: "center",
            pointerEvents: "none",
            maxWidth: "calc(100vw - 32px)",
        });
        document.body.appendChild(el);
    }
    return el;
}

function createProgressCard(jobId: string, fileName: string, onCancel: () => void, cancelTitle = "Cancel compression"): HTMLElement {
    const card = document.createElement("div");
    card.dataset.jobId = jobId;
    Object.assign(card.style, {
        background: "var(--background-floating, #18191c)",
        border: "1px solid var(--background-modifier-accent, #4f545c)",
        borderRadius: "8px",
        padding: "10px 12px",
        width: "min(420px, calc(100vw - 32px))",
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
    label.style.cssText = "font-size:13px;font-weight:600;color:var(--header-primary,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px;";
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
    cancelBtn.title = cancelTitle;
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

function getSizeUnit(value: unknown): SizeUnit {
    return value === "KB" || value === "MB" || value === "GB" ? value : "MB";
}

function getSizeBytes(value: number, unit: SizeUnit): number {
    return Math.max(1, value * SIZE_UNIT_BYTES[unit]);
}

function getStoredSizeBytes(settingKey: "compressionTarget" | "compressionThreshold", defaultValue: number): number {
    const legacyUnit = getSizeUnit((settings.store as Record<string, unknown>)[`${settingKey}Unit`]);
    const setting = normalizeSizeSetting(settings.store[settingKey], defaultValue, legacyUnit);
    return getSizeBytes(setting.value, setting.unit);
}

function getCompressionTargetBytes(): number {
    return getStoredSizeBytes("compressionTarget", 9);
}

function getCompressionTargetMB(): number {
    return getCompressionTargetBytes() / SIZE_UNIT_BYTES.MB;
}

function getCompressionThresholdBytes(): number {
    return getStoredSizeBytes("compressionThreshold", 10);
}

function getCompressionMode(): CompressionMode {
    const mode = settings.store.compressionMode;
    return mode === "media" || mode === "image" || mode === "off" ? mode : "auto";
}

function getFailedFileBehavior(): FailedFileBehavior {
    return settings.store.failedFileBehavior === "upload-original" ? "upload-original" : "skip";
}

function getConcurrentJobs(): number {
    const value = Number(settings.store.concurrentJobs);
    if (!Number.isFinite(value)) return 2;

    return Math.max(1, Math.min(8, Math.floor(value)));
}

function getMaxDimension(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;

    return Math.floor(parsed);
}

function getCustomMaxDimensions(): { width: number; height: number; } {
    return {
        width: getMaxDimension(settings.store.maxWidth),
        height: getMaxDimension(settings.store.maxHeight),
    };
}

function formatSize(sizeMB: number): string {
    const bytes = sizeMB * SIZE_UNIT_BYTES.MB;

    if (bytes < SIZE_UNIT_BYTES.MB) return `${(bytes / SIZE_UNIT_BYTES.KB).toFixed(1)} KB`;
    if (bytes >= SIZE_UNIT_BYTES.GB) return `${(bytes / SIZE_UNIT_BYTES.GB).toFixed(2)} GB`;

    return sizeMB >= 100
        ? `${Math.round(sizeMB)} MB`
        : `${sizeMB.toFixed(1)} MB`;
}

function formatBytes(bytes: number): string {
    return formatSize(bytes / SIZE_UNIT_BYTES.MB);
}

function formatPercentChange(originalSizeMB: number, sizeMB: number): string {
    if (originalSizeMB <= 0) return "0%";

    const change = ((sizeMB - originalSizeMB) / originalSizeMB) * 100;
    return `${change > 0 ? "+" : ""}${change.toFixed(1)}%`;
}

function formatResultLine(result: Extract<ProcessResult, { success: true; }>): string {
    if (result.output === "original") {
        return `${result.originalFileName}: kept original (${formatSize(result.originalSizeMB)}${result.note ? `, ${result.note}` : ""})`;
    }

    return `${result.originalFileName}: ${formatSize(result.originalSizeMB)} -> ${formatSize(result.sizeMB)} (${formatPercentChange(result.originalSizeMB, result.sizeMB)}${result.note ? `, ${result.note}` : ""})`;
}

function makeOriginalFallbackResult(file: File, note: string): Extract<ProcessResult, { success: true; }> | null {
    if (!settings.store.useOriginalIfWorse || file.size > getCompressionTargetBytes()) return null;

    return {
        success: true,
        file,
        originalFileName: file.name,
        originalSizeMB: file.size / SIZE_UNIT_BYTES.MB,
        sizeMB: file.size / SIZE_UNIT_BYTES.MB,
        encoderUsed: "original",
        output: "original",
        note,
    };
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
    const watcher = uploadWatchers.get(jobId);
    if (watcher) {
        clearInterval(watcher);
        uploadWatchers.delete(jobId);
    }
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay && overlay.childElementCount === 0) overlay.remove();
}

function createPostCompressionPreview(lines: string[], color: string) {
    if (lines.length === 0) return;

    const jobId = `preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const card = document.createElement("div");
    card.dataset.jobId = jobId;
    Object.assign(card.style, {
        background: "var(--background-floating, #18191c)",
        border: `1px solid ${color}`,
        borderRadius: "8px",
        padding: "10px 12px",
        width: "min(520px, calc(100vw - 32px))",
        pointerEvents: "none",
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
    });

    const title = document.createElement("div");
    title.style.cssText = "font-size:13px;font-weight:700;color:var(--header-primary,#fff);margin-bottom:4px;";
    title.textContent = "AutoCompress";

    const body = document.createElement("div");
    body.style.cssText = "font-size:12px;line-height:1.35;color:var(--text-normal,#dcddde);white-space:pre-wrap;";
    body.textContent = lines.slice(0, 6).join("\n") + (lines.length > 6 ? `\n+${lines.length - 6} more` : "");

    card.appendChild(title);
    card.appendChild(body);
    getOrCreateOverlay().appendChild(card);
    setTimeout(() => removeProgressCard(jobId), 8_000);
}

function isValid(files: FileList | undefined): files is FileList {
    return files !== undefined && files.length > 0;
}

function getCompressionKind(file: File): CompressionKind | null {
    if (MEDIA_FORMATS.has(file.type)) return "media";
    if (IMAGE_FORMATS.has(file.type)) return "image";
    return null;
}

function shouldCompressFile(file: File): boolean {
    const kind = getCompressionKind(file);
    const mode = getCompressionMode();

    if (kind === null || mode === "off") return false;
    if (mode !== "auto" && kind !== mode) return false;

    return file.size > getCompressionThresholdBytes();
}

function getBatchKey(files: File[]): string {
    return files
        .map(file => `${file.name}:${file.size}:${file.lastModified}:${file.type}`)
        .join("|");
}

function shouldSkipDuplicateBatch(files: File[]): boolean {
    const now = Date.now();
    const batchKey = getBatchKey(files);

    if (batchKey === lastHandledBatchKey && now - lastHandledBatchAt < DUPLICATE_BATCH_MS) {
        return true;
    }

    lastHandledBatchKey = batchKey;
    lastHandledBatchAt = now;
    return false;
}

function hasFileDrag(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function makeCancelledError(): Error & { cancelled: true; } {
    const err = new Error("cancelled") as Error & { cancelled: true; };
    err.cancelled = true;
    return err;
}

function getFileKey(file: File): string {
    return `${file.name}:${file.size}:${file.type}`;
}

function getUploadFile(upload: unknown): File | null {
    return (upload as { item?: { file?: File; }; })?.item?.file ?? null;
}

function addFilesToUploadManager(channelId: string, files: File[]) {
    if (files.length === 0) return;

    debugLog("adding files to Discord upload queue", {
        count: files.length,
        names: files.map(f => f.name),
        target: getCompressionTargetBytes(),
    });
    UploadManager.addFiles({
        channelId,
        draftType: DraftType.ChannelMessage,
        files: files.map(file => ({ file, platform: 1 })),
        showLargeMessageDialog: false,
    });
}

function createUploadCancelCard(channelId: string, files: File[]) {
    const jobId = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const fileKeys = new Set(files.map(getFileKey));
    let sawUploadInDraft = false;

    createProgressCard(jobId, `${files.length} pending upload${files.length === 1 ? "" : "s"}`, () => {
        UploadManager.clearAll(channelId, DraftType.ChannelMessage);
        showToast("Upload cancelled", Toasts.Type.MESSAGE);
        removeProgressCard(jobId);
    }, "Cancel upload");
    updateProgressCard(jobId, 100, "Ready to upload");

    const watcher = setInterval(() => {
        const uploads = UploadAttachmentStore
            .getUploads(channelId, DraftType.ChannelMessage)
            .map(getUploadFile)
            .filter((file): file is File => file !== null);
        const matchingCount = uploads.filter(file => fileKeys.has(getFileKey(file))).length;

        sawUploadInDraft ||= matchingCount > 0;

        if (sawUploadInDraft && matchingCount === 0) {
            removeProgressCard(jobId);
        }
    }, 500);
    uploadWatchers.set(jobId, watcher);

    setTimeout(() => {
        if (!sawUploadInDraft) removeProgressCard(jobId);
    }, 10_000);
}

let validationCache: { ffmpegPath: string; ffprobePath: string; encoder: string; } | null = null;
let lastHandledBatchKey = "";
let lastHandledBatchAt = 0;

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
    if (!isValid(files)) return;

    const allFiles = Array.from(files);
    if (!allFiles.some(shouldCompressFile)) return;

    debugLog("paste intercepted", allFiles.map(file => ({ name: file.name, size: file.size, type: file.type, shouldCompress: shouldCompressFile(file) })));
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (shouldSkipDuplicateBatch(allFiles)) return;
    if (allFiles.some(file => shouldCompressFile(file) && getCompressionKind(file) === "media") && !(await validateBinaries())) return;

    await handleFiles(allFiles);
}

function hookDragOver(event: DragEvent) {
    if (!hasFileDrag(event) || getCompressionMode() === "off") return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

async function hookDrop(event: DragEvent) {
    const files = event.dataTransfer?.files;
    if (!isValid(files)) return;

    const allFiles = Array.from(files);
    if (!allFiles.some(shouldCompressFile)) return;

    debugLog("drop intercepted", allFiles.map(file => ({ name: file.name, size: file.size, type: file.type, shouldCompress: shouldCompressFile(file) })));
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (shouldSkipDuplicateBatch(allFiles)) return;
    if (allFiles.some(file => shouldCompressFile(file) && getCompressionKind(file) === "media") && !(await validateBinaries())) return;

    await handleFiles(allFiles);
}

async function handleFiles(allFiles: File[]) {
    try {
        return await doHandleFiles(allFiles);
    } catch (err) {
        showNotification({
            title: "AutoCompress",
            body: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
            color: "#f04747",
            noPersist: false,
        });
    }
}

async function doHandleFiles(allFiles: File[]) {
    const compressibleFiles: File[] = [];
    const otherFiles: File[] = [];

    for (const file of allFiles) {
        if (shouldCompressFile(file)) {
            compressibleFiles.push(file);
        } else {
            otherFiles.push(file);
        }
    }

    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return;

    debugLog("handling files", {
        total: allFiles.length,
        compressible: compressibleFiles.length,
        passthrough: otherFiles.length,
        target: getCompressionTargetBytes(),
        threshold: getCompressionThresholdBytes(),
        concurrentJobs: getConcurrentJobs(),
    });

    if (compressibleFiles.length === 0) {
        if (otherFiles.length > 0) {
            await addFilesToUploadManager(channelId, otherFiles);
            createUploadCancelCard(channelId, otherFiles);
        }
        return;
    }

    const results = await processFilesLimited(compressibleFiles);

    const successful = results.filter((r): r is Extract<ProcessResult, { success: true; }> => r.success);
    const cancelled = results.filter((r): r is Extract<ProcessResult, { success: false; cancelled: true; }> => !r.success && !!r.cancelled);
    const failed = results.filter((r): r is Extract<ProcessResult, { success: false; }> => !r.success && !r.cancelled);
    const fallbackFiles = getFailedFileBehavior() === "upload-original"
        ? failed.map(r => r.file)
        : [];
    const toUpload = [...successful.map(r => r.file), ...fallbackFiles, ...otherFiles];

    debugLog("compression complete", {
        successful: successful.map(r => ({
            originalFileName: r.originalFileName,
            outputName: r.file.name,
            outputSize: r.file.size,
            output: r.output,
            encoderUsed: r.encoderUsed,
        })),
        failed: failed.map(r => ({ fileName: r.fileName, error: r.error })),
        cancelled: cancelled.length,
        fallbackUploads: fallbackFiles.map(file => ({ name: file.name, size: file.size })),
        uploadCount: toUpload.length,
    });

    if (cancelled.length === results.length) {
        showToast("Compression cancelled", Toasts.Type.MESSAGE);
        return;
    }

    const previewLines = [
        ...successful.map(formatResultLine),
        ...fallbackFiles.map(file => `${file.name}: uploaded original after compression failed`),
    ];
    createPostCompressionPreview(previewLines, failed.length === 0 ? "#43b581" : "#faa61a");

    const messageParts = [
        `Compressed ${successful.length}/${results.length} file(s)`,
        failed.length > 0 ? `Failed: ${failed.map(f => `${f.fileName} (${f.error})`).join(", ")}` : "",
        cancelled.length > 0 ? `Cancelled: ${cancelled.length}` : "",
        fallbackFiles.length > 0 ? `Fallback: uploaded ${fallbackFiles.length} original file(s)` : "",
        successful.length > 0 ? `Encoder: ${Array.from(new Set(successful.map(r => r.encoderUsed))).join(", ")}` : "",
        successful.length > 0
            ? `Changes:\n${successful.map(formatResultLine).join("\n")}`
            : "",
    ].filter(Boolean);

    if (toUpload.length > 0) {
        await addFilesToUploadManager(channelId, toUpload);
        createUploadCancelCard(channelId, toUpload);
    }

    showNotification({
        title: "AutoCompress",
        body: messageParts.join("\n"),
        color: failed.length === 0 ? "#43b581" : successful.length === 0 ? "#f04747" : "#faa61a",
        noPersist: false,
    });
}

async function processFilesLimited(files: File[]): Promise<ProcessResult[]> {
    const results: ProcessResult[] = new Array(files.length);
    const limit = getConcurrentJobs();
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < files.length) {
            const index = nextIndex++;
            results[index] = await processFile(files[index]);
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, files.length) }, () => worker()));
    return results;
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

async function loadImage(file: File): Promise<HTMLImageElement> {
    const url = URL.createObjectURL(file);

    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("failed to load image"));
        };
        image.src = url;
    });
}

function getImageBounds(width: number, height: number): { width: number; height: number; } {
    const custom = getCustomMaxDimensions();
    if (custom.width > 0 || custom.height > 0) {
        const scale = Math.min(
            1,
            custom.width > 0 ? custom.width / width : 1,
            custom.height > 0 ? custom.height / height : 1,
        );

        return {
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
        };
    }

    const bounds: Record<string, { width: number; height: number; }> = {
        "1080": { width: 1920, height: 1080 },
        "720": { width: 1280, height: 720 },
        "480": { width: 854, height: 480 },
    };
    const bound = bounds[settings.store.maxResolution];
    if (!bound) return { width, height };

    const scale = Math.min(1, bound.width / width, bound.height / height);
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (!blob) {
                reject(new Error(`${type} encoding is not available`));
                return;
            }

            resolve(blob);
        }, type, quality);
    });
}

function replaceExtension(fileName: string, extension: string): string {
    return fileName.includes(".")
        ? fileName.replace(/\.[^/.]+$/, extension)
        : `${fileName}${extension}`;
}

async function processImageFile(file: File): Promise<ProcessResult> {
    let cancelled = false;
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    createProgressCard(jobId, file.name, () => {
        cancelled = true;
        updateProgressCard(jobId, 0, "Cancelling...");
    });

    try {
        updateProgressCard(jobId, 5, "Loading image...");
        const image = await loadImage(file);
        if (cancelled) throw makeCancelledError();

        const dimensions = getImageBounds(image.naturalWidth, image.naturalHeight);
        const canvas = document.createElement("canvas");
        canvas.width = dimensions.width;
        canvas.height = dimensions.height;

        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("failed to create image canvas");

        ctx.drawImage(image, 0, 0, dimensions.width, dimensions.height);

        const outputType = file.type === "image/jpeg" ? "image/jpeg" : "image/webp";
        const targetBytes = getCompressionTargetBytes();
        let low = 0;
        let high = 0.92;
        let bestWithinTarget: Blob | null = null;
        const lowestQualityBlob = await canvasToBlob(canvas, outputType, 0);

        for (let i = 0; i < 7; i++) {
            if (cancelled) throw makeCancelledError();

            const quality = (low + high) / 2;
            const blob = await canvasToBlob(canvas, outputType, quality);
            updateProgressCard(jobId, 15 + Math.round(((i + 1) / 7) * 80), "Compressing image...");

            if (blob.size <= targetBytes) {
                bestWithinTarget = blob;
                low = quality;
            } else {
                high = quality;
            }
        }

        const bestBlob = bestWithinTarget ?? lowestQualityBlob;

        if (bestBlob.size >= file.size) {
            const fallback = makeOriginalFallbackResult(file, "compression was larger");
            if (fallback) return fallback;

            throw new Error("image compression did not reduce file size");
        }

        if (bestBlob.size > targetBytes && !settings.store.uploadIfSmaller) {
            throw new Error(`compressed image is ${formatBytes(bestBlob.size)}, above target ${formatBytes(targetBytes)}`);
        }

        updateProgressCard(jobId, 100, "100%");
        const outputName = outputType === file.type ? file.name : replaceExtension(file.name, ".webp");
        const compressedFile = new File([bestBlob], outputName, { type: outputType });

        return {
            success: true,
            file: compressedFile,
            originalFileName: file.name,
            originalSizeMB: file.size / (1024 * 1024),
            sizeMB: bestBlob.size / (1024 * 1024),
            encoderUsed: outputType === "image/jpeg" ? "canvas-jpeg" : "canvas-webp",
            output: "compressed",
            note: bestBlob.size > targetBytes ? "above target" : undefined,
        };
    } catch (err) {
        if ((err as { cancelled?: boolean; })?.cancelled) {
            return { success: false, file, fileName: file.name, error: "cancelled", cancelled: true };
        }

        return {
            success: false,
            file,
            fileName: file.name,
            error: err instanceof Error ? err.message : String(err),
        };
    } finally {
        removeProgressCard(jobId);
    }
}

async function processFile(file: File): Promise<ProcessResult> {
    if (getCompressionKind(file) === "image") return processImageFile(file);

    return processMediaFile(file);
}

async function processMediaFile(file: File): Promise<ProcessResult> {
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
            getCompressionTargetMB(),
            settings.store.compressionPreset,
            settings.store.maxResolution,
            getCustomMaxDimensions().width,
            getCustomMaxDimensions().height,
            settings.store.useHardwareDecode,
            settings.store.ffmpegTimeout * 1000,
        );

        if (!res.success) {
            if (res.cancelled) {
                return { success: false, file, fileName: file.name, error: "cancelled", cancelled: true };
            }

            return { success: false, file, fileName: file.name, error: res.error };
        }

        outPath = res.outPath;
        const bytes = await Native.readFileBytes(outPath);
        if (bytes.byteLength >= file.size) {
            const fallback = makeOriginalFallbackResult(file, "compression was larger");
            if (fallback) return fallback;

            return { success: false, file, fileName: file.name, error: "compressed file was not smaller" };
        }

        const targetBytes = getCompressionTargetBytes();
        if (bytes.byteLength > targetBytes && !settings.store.uploadIfSmaller) {
            return {
                success: false,
                file,
                fileName: file.name,
                error: `compressed file is ${formatBytes(bytes.byteLength)}, above target ${formatBytes(targetBytes)}`,
            };
        }

        const compressedFile = new File([bytes], file.name, { type: file.type });
        return {
            success: true,
            file: compressedFile,
            originalFileName: file.name,
            originalSizeMB: file.size / (1024 * 1024),
            sizeMB: bytes.byteLength / (1024 * 1024),
            encoderUsed: res.encoderUsed,
            output: "compressed",
            note: bytes.byteLength > targetBytes ? "above target" : undefined,
        };
    } catch (err) {
        if ((err as { cancelled?: boolean; })?.cancelled) {
            return { success: false, file, fileName: file.name, error: "cancelled", cancelled: true };
        }

        return {
            success: false,
            file,
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
    description: "Automatically compress videos, audio, and images to reach a target size",
    authors: [{ name: "dyn", id: 262458273247002636n }],
    settings,

    start() {
        document.addEventListener("dragover", hookDragOver, { capture: true });
        document.addEventListener("drop", hookDrop, { capture: true });
        document.addEventListener("paste", hookPaste, { capture: true });
    },

    stop() {
        document.removeEventListener("dragover", hookDragOver, { capture: true });
        document.removeEventListener("drop", hookDrop, { capture: true });
        document.removeEventListener("paste", hookPaste, { capture: true });
        document.getElementById(OVERLAY_ID)?.remove();
        for (const watcher of uploadWatchers.values()) clearInterval(watcher);
        uploadWatchers.clear();
        validationCache = null;
        lastHandledBatchKey = "";
        lastHandledBatchAt = 0;
        progressEstimates.clear();
    },
});
