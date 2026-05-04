/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

import { app } from "electron";

const cache: Partial<Record<"ffmpeg" | "ffprobe", string>> = {};

export type VideoEncoder =
    | "h264_nvenc"
    | "h264_amf"
    | "h264_qsv"
    | "h264_videotoolbox"
    | "libx264";

let cachedEncoder: VideoEncoder | null = null;

const GPU_ENCODERS: VideoEncoder[] = process.platform === "darwin"
    ? ["h264_videotoolbox"]
    : ["h264_nvenc", "h264_amf", "h264_qsv"];

const VENDOR_ENCODER_MAP: Record<number, VideoEncoder> = {
    0x10DE: "h264_nvenc",
    0x1002: "h264_amf",
    0x1022: "h264_amf",
    0x8086: "h264_qsv",
};

export function getEncoderFallbackOrder(preferredEncoder: VideoEncoder): VideoEncoder[] {
    const candidates = preferredEncoder === "libx264"
        ? [...GPU_ENCODERS, preferredEncoder]
        : [preferredEncoder, ...GPU_ENCODERS, "libx264" as VideoEncoder];

    return candidates.filter((encoder, index) => candidates.indexOf(encoder) === index);
}

async function getVendorEncoder(): Promise<VideoEncoder | null> {
    if (process.platform === "darwin") {
        return "h264_videotoolbox";
    }

    try {
        const info = await app.getGPUInfo("complete") as {
            gpuDevice?: Array<{ vendorId?: number; description?: string; }>;
        };
        const devices = info?.gpuDevice ?? [];

        for (const device of devices) {
            const { vendorId } = device;
            if (typeof vendorId === "number") {
                const encoder = VENDOR_ENCODER_MAP[vendorId];
                if (encoder) return encoder;
            }
        }

        for (const device of devices) {
            const desc = (device.description ?? "").toLowerCase();
            if (desc.includes("nvidia")) return "h264_nvenc";
            if (desc.includes("amd") || desc.includes("radeon")) return "h264_amf";
            if (desc.includes("intel")) return "h264_qsv";
        }
    } catch {
        // app.getGPUInfo can throw in sandboxed environments — not fatal.
    }

    return null;
}

export function testEncodeWithError(
    ffmpegPath: string,
    encoder: VideoEncoder,
): Promise<{ success: true; } | { success: false; error: string; }> {
    return new Promise(resolve => {
        const encoderArgs: Record<VideoEncoder, string[]> = {
            "h264_nvenc": ["-c:v", "h264_nvenc", "-rc", "cbr", "-b:v", "1000k"],
            "h264_amf": ["-c:v", "h264_amf", "-rc", "cbr", "-b:v", "1000k"],
            "h264_qsv": ["-c:v", "h264_qsv", "-look_ahead", "0", "-b:v", "1000k"],
            "h264_videotoolbox": ["-c:v", "h264_videotoolbox", "-b:v", "1000k"],
            "libx264": ["-c:v", "libx264", "-preset", "ultrafast", "-b:v", "1000k"],
        };

        const args = [
            "-f", "lavfi",
            "-i", "nullsrc=s=320x240:d=1",
            ...encoderArgs[encoder],
            "-an",
            "-f", "null",
            "-",
        ];

        const p = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
        let errOut = "";
        let settled = false;

        p.stderr.on("data", (d: Buffer) => {
            errOut += d.toString();
        });

        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            p.kill();
            resolve({ success: false, error: "timed out after 8s" });
        }, 8000);

        p.on("close", code => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (code === 0) {
                resolve({ success: true });
                return;
            }

            const tail = errOut.trim().split("\n").slice(-5).join("\n");
            resolve({ success: false, error: tail || `ffmpeg exited with code ${code}` });
        });

        p.on("error", err => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve({ success: false, error: err.message });
        });
    });
}

async function testEncode(ffmpegPath: string, encoder: VideoEncoder): Promise<boolean> {
    const result = await testEncodeWithError(ffmpegPath, encoder);
    if (!result.success) {
        console.log(`[AutoCompress] testEncode ${encoder} failed: ${result.error}`);
    }
    return result.success;
}

export async function detectEncoder(): Promise<VideoEncoder> {
    if (cachedEncoder !== null) return cachedEncoder;

    const ffmpegPath = pullBinary("ffmpeg");
    const vendorEncoder = await getVendorEncoder();

    if (vendorEncoder) {
        const works = await testEncode(ffmpegPath, vendorEncoder);
        if (works) {
            cachedEncoder = vendorEncoder;
            return cachedEncoder;
        }
    }

    for (const encoder of GPU_ENCODERS) {
        if (encoder === vendorEncoder) continue;
        const works = await testEncode(ffmpegPath, encoder);
        if (works) {
            cachedEncoder = encoder;
            return cachedEncoder;
        }
    }

    cachedEncoder = "libx264";
    return cachedEncoder;
}

export function clearEncoderCache(): void {
    cachedEncoder = null;
}

export function clearBinaryCache(): void {
    delete cache.ffmpeg;
    delete cache.ffprobe;
}

function resolveFromPath(bin: "ffmpeg" | "ffprobe"): string | null {
    const name = process.platform === "win32" ? `${bin}.exe` : bin;
    const pathEnv = process.env.PATH ?? "";
    const dirs = pathEnv.split(path.delimiter);

    for (const dir of dirs) {
        if (!dir) continue;
        const candidate = path.join(dir, name);
        try {
            require("node:fs").accessSync(candidate);
            return candidate;
        } catch {
            continue;
        }
    }

    return null;
}

function candidatePaths(bin: "ffmpeg" | "ffprobe"): string[] {
    const fromPath = resolveFromPath(bin);

    switch (process.platform) {
        case "win32": {
            const hardcoded = [
                `C:\\ffmpeg\\bin\\${bin}.exe`,
                `C:\\Program Files\\ffmpeg\\bin\\${bin}.exe`,
                `C:\\Program Files (x86)\\ffmpeg\\bin\\${bin}.exe`,
                `${process.env.USERPROFILE}\\scoop\\shims\\${bin}.exe`,
                `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Links\\${bin}.exe`,
            ];
            return fromPath ? [fromPath, ...hardcoded] : hardcoded;
        }
        case "darwin": {
            const hardcoded = [
                `/opt/homebrew/bin/${bin}`,
                `/usr/local/bin/${bin}`,
                `/usr/bin/${bin}`,
            ];
            return fromPath ? [fromPath, ...hardcoded] : hardcoded;
        }
        default: {
            const hardcoded = [
                `/usr/bin/${bin}`,
                `/usr/local/bin/${bin}`,
                `/bin/${bin}`,
                `/snap/bin/${bin}`,
                `/app/bin/${bin}`,
            ];
            return fromPath ? [fromPath, ...hardcoded] : hardcoded;
        }
    }
}

async function validateBinary(binPath: string, binName: string, timeoutMs = 5000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const p = spawn(binPath, ["-version"], { shell: false });

        let out = "";
        let errOut = "";
        let timeExceeded = false;

        const timeout = setTimeout(() => {
            timeExceeded = true;
            p.kill();
            reject(new Error(`${binPath} validation timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        p.stdout.on("data", d => {
            out += d.toString();
        });
        p.stderr.on("data", d => {
            errOut += d.toString();
        });

        p.on("close", code => {
            clearTimeout(timeout);
            if (timeExceeded) return;

            const combined = `${out}\n${errOut}`.toLowerCase();
            if (code !== 0 || !combined.includes(binName)) {
                reject(new Error(`${binPath} is not a valid ${binName} binary`));
            } else {
                resolve();
            }
        });

        p.on("error", err => {
            clearTimeout(timeout);
            if (!timeExceeded) reject(err);
        });
    });
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

export function pullBinary(bin: "ffmpeg" | "ffprobe"): string {
    const binPath = cache[bin];
    if (!binPath) throw new Error("requested binary has not been resolved");
    return binPath;
}

export async function resolveBinary(
    userPath: string | undefined,
    bin: "ffmpeg" | "ffprobe",
): Promise<string> {
    if (cache[bin]) return cache[bin] as string;

    if (userPath) {
        if (!path.isAbsolute(userPath)) {
            throw new Error(`${bin} path must be absolute`);
        }
        if (!(await fileExists(userPath))) {
            throw new Error(`${bin} not found at ${userPath}`);
        }

        await validateBinary(userPath, bin);
        cache[bin] = userPath;
        return userPath;
    }

    for (const candidate of candidatePaths(bin)) {
        if (!(await fileExists(candidate))) continue;

        try {
            await validateBinary(candidate, bin);
            cache[bin] = candidate;
            return candidate;
        } catch {
            continue;
        }
    }

    throw new Error(`${bin} not found, either needs installation or define a custom path`);
}
