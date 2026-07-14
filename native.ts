import { spawn } from "child_process";
import type { IpcMainInvokeEvent } from "electron";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

function run(args: string[]): Promise<{ ok: boolean; enoent?: boolean; }> {
    return new Promise(resolve => {
        const child = spawn("ffmpeg", args, { windowsHide: true });
        child.on("error", (e: any) => resolve({ ok: false, enoent: e?.code === "ENOENT" }));
        child.stderr?.on("data", () => { });
        child.on("close", code => resolve({ ok: code === 0 }));
    });
}

export async function ffmpegAvailable(_: IpcMainInvokeEvent): Promise<boolean> {
    return (await run(["-version"])).ok;
}

let cachedEncoder: string | undefined;

async function encoderWorks(enc: string): Promise<boolean> {
    return (await run(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.1:r=5", "-c:v", enc, "-f", "null", "-"])).ok;
}

async function pickVideoEncoder(): Promise<string> {
    if (cachedEncoder !== undefined) return cachedEncoder;
    for (const enc of ["h264_nvenc", "h264_qsv", "h264_amf"]) {
        if (await encoderWorks(enc)) { cachedEncoder = enc; return enc; }
    }
    cachedEncoder = "libx264";
    return cachedEncoder;
}

const SCALE = "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";

function videoEncoderArgs(encoder: string, vk: string, bufsize: string): string[] {
    switch (encoder) {
        case "h264_nvenc":
            return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-b:v", vk, "-maxrate", vk, "-bufsize", bufsize, "-pix_fmt", "yuv420p"];
        case "h264_qsv":
            return ["-c:v", "h264_qsv", "-b:v", vk, "-maxrate", vk, "-pix_fmt", "nv12"];
        case "h264_amf":
            return ["-c:v", "h264_amf", "-b:v", vk, "-maxrate", vk, "-pix_fmt", "yuv420p"];
        default:
            return ["-c:v", "libx264", "-preset", "ultrafast", "-b:v", vk, "-maxrate", vk, "-bufsize", bufsize, "-pix_fmt", "yuv420p"];
    }
}

interface CompressOpts {
    name: string;
    path?: string;
    data?: Uint8Array;
    durationSec: number;
    targetBytes: number;
    isVideo: boolean;
}

type CompressResult =
    | { ok: true; data: Uint8Array; ext: string; }
    | { ok: false; error: string; };

export async function compress(_: IpcMainInvokeEvent, opts: CompressOpts): Promise<CompressResult> {
    const { name, path, data, durationSec, targetBytes, isVideo } = opts;
    if (!durationSec || durationSec <= 0) return { ok: false, error: "couldn't read its duration" };

    let dir: string | null = null;
    try {
        dir = await mkdtemp(join(tmpdir(), "thecollective-"));

        let inPath: string;
        if (typeof path === "string" && path) {
            inPath = path;
        } else if (data instanceof Uint8Array && data.byteLength) {
            const inExt = (name.match(/\.[a-z0-9]+$/i)?.[0] ?? ".bin").toLowerCase();
            inPath = join(dir, "in" + inExt);
            await writeFile(inPath, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
        } else {
            return { ok: false, error: "no file data" };
        }

        const totalBitrate = Math.floor((targetBytes * 8 * 0.9) / durationSec);
        const head = ["-y", "-nostdin", "-loglevel", "error", "-i", inPath];

        let ext: string;
        let outPath: string;

        if (isVideo) {
            const videoB = Math.max(100_000, totalBitrate - 128_000);
            const vk = `${Math.round(videoB / 1000)}k`;
            const bufsize = `${Math.round(videoB / 500)}k`;
            ext = "mp4";
            outPath = join(dir, "out.mp4");
            const tail = ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outPath];

            const encoder = await pickVideoEncoder();
            let res = await run([...head, "-vf", SCALE, ...videoEncoderArgs(encoder, vk, bufsize), ...tail]);

            if (!res.ok && encoder !== "libx264") {
                cachedEncoder = "libx264";
                res = await run([...head, "-vf", SCALE, ...videoEncoderArgs("libx264", vk, bufsize), ...tail]);
            }
            if (!res.ok) return { ok: false, error: res.enoent ? "ffmpeg is not installed or not on PATH" : "ffmpeg failed" };
        } else {
            const audioB = Math.max(32_000, Math.min(totalBitrate, 320_000));
            ext = "mp3";
            outPath = join(dir, "out.mp3");
            const res = await run([...head, "-vn", "-c:a", "libmp3lame", "-b:a", `${Math.round(audioB / 1000)}k`, outPath]);
            if (!res.ok) return { ok: false, error: res.enoent ? "ffmpeg is not installed or not on PATH" : "ffmpeg failed" };
        }

        const outBuf = await readFile(outPath);
        return { ok: true, data: new Uint8Array(outBuf.buffer, outBuf.byteOffset, outBuf.byteLength), ext };
    } catch (e) {
        return { ok: false, error: String((e as any)?.message ?? e) };
    } finally {
        if (dir) rm(dir, { recursive: true, force: true }).catch(() => { });
    }
}
