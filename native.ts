/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChildProcess, spawn } from "node:child_process";
import { createWriteStream, WriteStream } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { IpcMainInvokeEvent } from "electron";

import {
    clearBinaryCache,
    clearEncoderCache,
    detectEncoder,
    getEncoderFallbackOrder,
    pullBinary,
    resolveBinary,
    VideoEncoder,
} from "./resolve";

type CompressResult =
    | { success: true; outPath: string; encoderUsed: string; }
    | { success: false; error: string; cancelled?: true; };

const openStreams = new Map<string, WriteStream>();
const progressMap = new Map<string, number>();
const activeJobs = new Map<string, ChildProcess>();
const cancelledJobs = new Set<string>();

function mapNvencPreset(preset: string): string {
    const presets: Record<string, string> = {
        ultrafast: "p1",
        fast: "p2",
        medium: "p4",
        slow: "p6",
        veryslow: "p7",
    };

    return presets[preset] ?? "p4";
}

function mapAmfQuality(preset: string): string {
    const qualities: Record<string, string> = {
        ultrafast: "speed",
        fast: "speed",
        medium: "balanced",
        slow: "quality",
        veryslow: "quality",
    };

    return qualities[preset] ?? "balanced";
}

function mapQsvPreset(preset: string): string {
    const presets: Record<string, string> = {
        ultrafast: "veryfast",
        fast: "fast",
        medium: "medium",
        slow: "slow",
        veryslow: "veryslow",
    };

    return presets[preset] ?? "medium";
}

function buildEncoderArgs(encoder: VideoEncoder, vidBitrate: number, preset: string): string[] {
    switch (encoder) {
        case "h264_nvenc":
            return [
                "-c:v", "h264_nvenc",
                "-preset", mapNvencPreset(preset),
                "-b:v", `${vidBitrate}k`,
                "-maxrate", `${vidBitrate}k`,
                "-bufsize", `${vidBitrate * 2}k`,
                "-rc", "cbr",
                "-cbr", "true",
            ];

        case "h264_amf":
            return [
                "-c:v", "h264_amf",
                "-quality", mapAmfQuality(preset),
                "-b:v", `${vidBitrate}k`,
                "-maxrate", `${vidBitrate}k`,
                "-bufsize", `${vidBitrate * 2}k`,
                "-rc", "cbr",
            ];

        case "h264_qsv":
            return [
                "-c:v", "h264_qsv",
                "-preset", mapQsvPreset(preset),
                "-b:v", `${vidBitrate}k`,
                "-maxrate", `${vidBitrate}k`,
                "-bufsize", `${vidBitrate * 2}k`,
                "-look_ahead", "0",
            ];

        case "h264_videotoolbox":
            return [
                "-c:v", "h264_videotoolbox",
                "-b:v", `${vidBitrate}k`,
                "-maxrate", `${vidBitrate}k`,
                "-bufsize", `${vidBitrate * 2}k`,
            ];

        case "libx264":
        default:
            return [
                "-c:v", "libx264",
                "-b:v", `${vidBitrate}k`,
                "-maxrate", `${vidBitrate}k`,
                "-bufsize", `${vidBitrate * 2}k`,
                "-preset", preset,
            ];
    }
}

function isAudioMime(mimeType: string): boolean {
    return mimeType.startsWith("audio/");
}

export async function openTempFile(_: IpcMainInvokeEvent, fileName: string): Promise<string> {
    const ext = path.extname(fileName) || ".tmp";
    const tempPath = path.join(os.tmpdir(), `ac_in_${Date.now()}${ext}`);
    openStreams.set(tempPath, createWriteStream(tempPath));
    return tempPath;
}

export function writeChunk(_: IpcMainInvokeEvent, tempPath: string, chunk: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
        const stream = openStreams.get(tempPath);
        if (!stream) {
            reject(new Error(`no open stream for ${tempPath}`));
            return;
        }

        stream.write(Buffer.from(chunk), err => err ? reject(err) : resolve());
    });
}

export function closeTempFile(_: IpcMainInvokeEvent, tempPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const stream = openStreams.get(tempPath);
        if (!stream) {
            resolve();
            return;
        }

        stream.once("error", reject);
        stream.end(() => {
            openStreams.delete(tempPath);
            resolve();
        });
    });
}

export function getProgress(_: IpcMainInvokeEvent, jobId: string): number | null {
    return progressMap.get(jobId) ?? null;
}

export function clearProgress(_: IpcMainInvokeEvent, jobId: string): void {
    progressMap.delete(jobId);
    cancelledJobs.delete(jobId);
}

export function cancelJob(_: IpcMainInvokeEvent, jobId: string): void {
    cancelledJobs.add(jobId);
    const proc = activeJobs.get(jobId);
    if (proc) {
        proc.kill();
        activeJobs.delete(jobId);
    }
}

export async function testBinaries(
    _: IpcMainInvokeEvent,
    ffmpegPath: string | undefined,
    ffprobePath: string | undefined,
) {
    try {
        clearBinaryCache();
        clearEncoderCache();

        await resolveBinary(ffmpegPath, "ffmpeg");
        await resolveBinary(ffprobePath, "ffprobe");

        const encoder = await detectEncoder();
        return { success: true, encoder };
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

export async function getDiagnostics(_: IpcMainInvokeEvent): Promise<object> {
    const { app } = await import("electron");

    const ffmpegPath = (() => {
        try {
            return pullBinary("ffmpeg");
        } catch {
            return null;
        }
    })();

    let gpuDevices: unknown = null;
    let gpuError: string | null = null;

    try {
        const info = await app.getGPUInfo("complete") as { gpuDevice?: unknown; };
        gpuDevices = info?.gpuDevice ?? null;
    } catch (e) {
        gpuError = e instanceof Error ? e.message : String(e);
    }

    let h264Encoders: string[] | null = null;
    if (ffmpegPath) {
        h264Encoders = await new Promise(resolve => {
            const p = spawn(ffmpegPath, ["-encoders", "-v", "quiet"]);
            let out = "";

            p.stdout.on("data", d => { out += d.toString(); });
            p.stderr.on("data", d => { out += d.toString(); });

            p.on("close", () => {
                resolve(
                    out
                        .split("\n")
                        .filter(line => line.toLowerCase().includes("h264"))
                        .map(line => line.trim())
                );
            });

            p.on("error", () => resolve(null));
        });
    }

    const encoderTests: Record<string, string> = {};
    if (ffmpegPath) {
        const { testEncodeWithError } = await import("./resolve");
        const encoders = ["h264_nvenc", "h264_amf", "h264_qsv", "h264_videotoolbox", "libx264"] as const;

        for (const enc of encoders) {
            const result = await testEncodeWithError(ffmpegPath, enc);
            encoderTests[enc] = result.success ? "ok" : result.error;
        }
    }

    return {
        platform: process.platform,
        ffmpegPath,
        gpuError,
        gpuDevices,
        h264Encoders,
        encoderTests,
    };
}

export async function handleFile(
    _: IpcMainInvokeEvent,
    jobId: string,
    filePath: string,
    fileName: string,
    mimeType: string,
    target: number,
    preset: string,
    resolution: string,
    timeout: number,
): Promise<CompressResult> {
    const preferredExt = isAudioMime(mimeType) ? ".m4a" : ".mp4";
    const fileExt = path.extname(fileName) || preferredExt;
    const outPath = path.join(os.tmpdir(), `ac_out_${Date.now()}${fileExt}`);

    try {
        const duration = await getMediaDuration(filePath);

        const audioBitrate = 128;
        const targetBits = target * 8 * 1024 * 1024;
        const audioBits = audioBitrate * 1000 * duration;
        const hasVideo = !isAudioMime(mimeType);
        const videoBitrate = hasVideo
            ? Math.floor((targetBits - audioBits) / duration / 1000)
            : 0;

        if (hasVideo && videoBitrate < 100) {
            return { success: false, error: `target bitrate too low (${videoBitrate}k)` };
        }

        const onProgress = (percent: number) => progressMap.set(jobId, percent);
        const registerJob = (proc: ChildProcess) => activeJobs.set(jobId, proc);

        if (hasVideo) {
            const preferredEncoder = await detectEncoder();
            const encoders = getEncoderFallbackOrder(preferredEncoder);
            const errors: string[] = [];
            let encoderUsed: VideoEncoder | null = null;

            encoderLoop:
            for (const encoder of encoders) {
                if (cancelledJobs.has(jobId)) {
                    const err = new Error("cancelled") as Error & { cancelled?: boolean; };
                    err.cancelled = true;
                    throw err;
                }

                const resolutionAttempts = resolution === "original" && encoder !== "libx264"
                    ? ["original", "1080"]
                    : [resolution];

                for (const resolutionAttempt of resolutionAttempts) {
                    await unlink(outPath).catch(() => {});
                    onProgress(0);

                    try {
                        await compressVideo(
                            filePath,
                            outPath,
                            videoBitrate,
                            audioBitrate,
                            preset,
                            resolutionAttempt,
                            timeout,
                            encoder,
                            duration,
                            onProgress,
                            registerJob,
                            () => cancelledJobs.has(jobId),
                        );
                        encoderUsed = encoder;
                        break encoderLoop;
                    } catch (err) {
                        activeJobs.delete(jobId);

                        const maybeCancelled = err as { cancelled?: boolean; message?: string; toString(): string; };
                        if (maybeCancelled?.cancelled || cancelledJobs.has(jobId)) {
                            const cancelErr = new Error("cancelled") as Error & { cancelled?: boolean; };
                            cancelErr.cancelled = true;
                            throw cancelErr;
                        }

                        errors.push(`${encoder}${resolutionAttempt === resolution ? "" : ` (${resolutionAttempt}p retry)`}: ${maybeCancelled?.message || maybeCancelled?.toString() || "unknown error"}`);
                    }
                }
            }

            if (!encoderUsed) {
                return {
                    success: false,
                    error: `all encoders failed:\n${errors.join("\n\n")}`,
                };
            }

            activeJobs.delete(jobId);
            return { success: true, outPath, encoderUsed };
        } else {
            await compressAudio(
                filePath,
                outPath,
                audioBitrate,
                timeout,
                duration,
                onProgress,
                registerJob,
                () => cancelledJobs.has(jobId),
            );

            activeJobs.delete(jobId);
            return { success: true, outPath, encoderUsed: "aac" };
        }
    } catch (err) {
        activeJobs.delete(jobId);
        await unlink(outPath).catch(() => {});

        const maybeCancelled = err as { cancelled?: boolean; message?: string; toString(): string; };
        if (maybeCancelled?.cancelled) {
            return { success: false, error: "cancelled", cancelled: true };
        }

        return {
            success: false,
            error: maybeCancelled?.message || maybeCancelled?.toString() || "unknown error",
        };
    }
}

export async function cleanupFile(_: IpcMainInvokeEvent, filePath: string): Promise<void> {
    await unlink(filePath).catch(() => {});
}

export async function readFileBytes(_: IpcMainInvokeEvent, filePath: string): Promise<ArrayBuffer> {
    const data = await readFile(filePath);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

function getMediaDuration(inputPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn(pullBinary("ffprobe"), [
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            inputPath,
        ]);

        let out = "";
        let errOut = "";

        ffprobe.stdout.on("data", d => { out += d.toString(); });
        ffprobe.stderr.on("data", d => { errOut += d.toString(); });

        ffprobe.on("close", code => {
            if (code !== 0) {
                reject(new Error(`ffprobe exited with ${code}, ${errOut.trim()}`));
                return;
            }

            const duration = parseFloat(out.trim());
            if (Number.isNaN(duration) || duration <= 0) {
                reject(new Error("ffprobe returned invalid duration"));
                return;
            }

            resolve(duration);
        });

        ffprobe.on("error", err => reject(new Error(`failed to spawn ffprobe: ${err.message}`)));
    });
}

function parseProgressPercent(line: string, totalDuration: number): number | null {
    const trimmed = line.trim();

    const outTimeMs = trimmed.match(/^out_time_ms=(\d+)$/);
    if (outTimeMs) {
        const elapsed = parseInt(outTimeMs[1], 10) / 1_000_000;
        return Math.min(99, Math.floor((elapsed / totalDuration) * 100));
    }

    const outTime = trimmed.match(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)$/);
    if (outTime) {
        const elapsed =
            parseInt(outTime[1], 10) * 3600 +
            parseInt(outTime[2], 10) * 60 +
            parseFloat(outTime[3]);
        return Math.min(99, Math.floor((elapsed / totalDuration) * 100));
    }

    const statsTime = trimmed.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (statsTime) {
        const elapsed =
            parseInt(statsTime[1], 10) * 3600 +
            parseInt(statsTime[2], 10) * 60 +
            parseFloat(statsTime[3]);
        return Math.min(99, Math.floor((elapsed / totalDuration) * 100));
    }

    return null;
}

function buildScaleFilter(maxResolution: string): string | null {
    const resolutionMap: Record<string, string> = {
        "1080": "scale=w='min(iw,1920)':h='min(ih,1080)':force_original_aspect_ratio=decrease,pad='ceil(iw/2)*2':'ceil(ih/2)*2'",
        "720": "scale=w='min(iw,1280)':h='min(ih,720)':force_original_aspect_ratio=decrease,pad='ceil(iw/2)*2':'ceil(ih/2)*2'",
        "480": "scale=w='min(iw,854)':h='min(ih,480)':force_original_aspect_ratio=decrease,pad='ceil(iw/2)*2':'ceil(ih/2)*2'",
    };

    return resolutionMap[maxResolution] ?? null;
}

function buildVideoFilter(maxResolution: string): string | null {
    const scaleFilter = buildScaleFilter(maxResolution);
    if (scaleFilter) return `${scaleFilter},format=yuv420p`;

    return null;
}

function compressVideo(
    inputPath: string,
    outputPath: string,
    vidBitrate: number,
    audioBitrate: number,
    preset: string,
    maxResolution: string,
    ffmpegTimeout: number,
    encoder: VideoEncoder,
    duration: number,
    onProgress: (percent: number) => void,
    onSpawn: (proc: ChildProcess) => void,
    isCancelled: () => boolean,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const args = [
            "-y",
            "-hide_banner",
            "-i", inputPath,
            "-map", "0:v:0",
            "-map", "0:a?",
            ...buildEncoderArgs(encoder, vidBitrate, preset),
        ];

        const filter = buildVideoFilter(maxResolution);
        if (filter) {
            args.push("-vf", filter);
        }

        args.push(
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", `${audioBitrate}k`,
            "-map_metadata", "0",
            "-movflags", "+faststart",
            "-progress", "pipe:1",
            "-nostats",
            outputPath,
        );

        const ffmpeg = spawn(pullBinary("ffmpeg"), args);
        onSpawn(ffmpeg);

        let errOut = "";
        let settled = false;

        ffmpeg.stdout.on("data", data => {
            const chunk = data.toString();

            for (const line of chunk.split("\n")) {
                const pct = parseProgressPercent(line, duration);
                if (pct !== null) onProgress(pct);
            }
        });

        ffmpeg.stderr.on("data", data => {
            errOut += data.toString();
        });

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            ffmpeg.kill();
            reject(new Error(`ffmpeg exceeded allotted time of ${ffmpegTimeout / 1000}s`));
        }, ffmpegTimeout);

        ffmpeg.on("close", (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            if (isCancelled() || signal === "SIGTERM" || signal === "SIGKILL") {
                const err = new Error("cancelled") as Error & { cancelled?: boolean; };
                err.cancelled = true;
                reject(err);
                return;
            }

            if (code === 0) {
                onProgress(100);
                resolve();
                return;
            }

            const tail = errOut.trim().split("\n").slice(-8).join("\n");
            reject(new Error(`${encoder} failed (code ${code}):\n${tail}`));
        });

        ffmpeg.on("error", err => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`ffmpeg spawn error: ${err}. stderr: ${errOut}`));
        });
    });
}

function compressAudio(
    inputPath: string,
    outputPath: string,
    audioBitrate: number,
    ffmpegTimeout: number,
    duration: number,
    onProgress: (percent: number) => void,
    onSpawn: (proc: ChildProcess) => void,
    isCancelled: () => boolean,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const args = [
            "-y",
            "-hide_banner",
            "-i", inputPath,
            "-vn",
            "-c:a", "aac",
            "-b:a", `${audioBitrate}k`,
            "-map_metadata", "0",
            "-progress", "pipe:1",
            "-nostats",
            outputPath,
        ];

        const ffmpeg = spawn(pullBinary("ffmpeg"), args);
        onSpawn(ffmpeg);

        let errOut = "";
        let settled = false;

        ffmpeg.stdout.on("data", data => {
            const chunk = data.toString();

            for (const line of chunk.split("\n")) {
                const pct = parseProgressPercent(line, duration);
                if (pct !== null) onProgress(pct);
            }
        });

        ffmpeg.stderr.on("data", data => {
            errOut += data.toString();
        });

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            ffmpeg.kill();
            reject(new Error(`ffmpeg exceeded allotted time of ${ffmpegTimeout / 1000}s`));
        }, ffmpegTimeout);

        ffmpeg.on("close", (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            if (isCancelled() || signal === "SIGTERM" || signal === "SIGKILL") {
                const err = new Error("cancelled") as Error & { cancelled?: boolean; };
                err.cancelled = true;
                reject(err);
                return;
            }

            if (code === 0) {
                onProgress(100);
                resolve();
                return;
            }

            const tail = errOut.trim().split("\n").slice(-8).join("\n");
            reject(new Error(`aac failed (code ${code}):\n${tail}`));
        });

        ffmpeg.on("error", err => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`ffmpeg spawn error: ${err}. stderr: ${errOut}`));
        });
    });
}
