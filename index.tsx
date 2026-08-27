import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import { Alerts, ChannelStore, DraftType, FluxDispatcher, SelectedChannelStore, showToast, Toasts, UploadHandler, UserStore } from "@webpack/common";

const Native = VencordNative.pluginHelpers.TheCollective as PluginNative<typeof import("./native")>;

const logger = new Logger("TheCollective");
const { getUserMaxFileSize } = findByPropsLazy("getUserMaxFileSize");
const getGuildAwareMaxFileSize = findByCodeLazy("getUserMaxFileSize(", "getGuildMaxFileSize") as undefined | ((guildId: string | null) => number);

let interceptor: ((event: any) => void) | null = null;
let pasteHandler: ((e: ClipboardEvent) => void) | null = null;
let dropHandler: ((e: DragEvent) => void) | null = null;
const ours = new WeakSet<File>();

function isCompressible(file: File): boolean {
    return /^(video|audio)\//i.test(file.type)
        || /\.(mp4|mov|mkv|webm|m4v|avi|mp3|wav|flac|ogg|m4a|aac|opus)$/i.test(file.name);
}

function isVideoFile(file: File): boolean {
    return file.type.startsWith("video") || /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(file.name);
}

function baseName(name: string): string {
    return name.replace(/\.[^./\\]+$/, "");
}

function fmt(bytes: number): string {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function getDuration(file: File): Promise<number> {
    return new Promise(resolve => {
        const el = document.createElement(file.type.startsWith("video") ? "video" : "audio") as HTMLMediaElement;
        const url = URL.createObjectURL(file);
        const done = (d: number) => { URL.revokeObjectURL(url); resolve(Number.isFinite(d) && d > 0 ? d : 0); };
        el.preload = "metadata";
        el.onloadedmetadata = () => done(el.duration);
        el.onerror = () => done(0);
        el.src = url;
    });
}

function confirmCompress(name: string, size: number): Promise<boolean> {
    return new Promise(resolve => {
        let settled = false;
        const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
        Alerts.show({
            title: "Compress file?",
            body: `${name} is ${fmt(size)}, over your upload limit. Compress it to fit?`,
            confirmText: "Compress",
            cancelText: "Don't send",
            onConfirm: () => done(true),
            onCancel: () => done(false),
            onCloseCallback: () => done(false)
        });
    });
}

const settings = definePluginSettings({
    headroom: {
        type: OptionType.SELECT,
        description: "how much to stay under the size limit. higher = smaller files but more aggressive compression; lower = closer to the limit but better quality.",
        options: [
            { label: "Low", value: 5 },
            { label: "Medium", value: 10, default: true },
            { label: "High", value: 15 },
            { label: "Extra", value: 20 },
            { label: "Max", value: 25 }
        ]
    },
    askPermission: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "ask before compressing."
    }
});

function getLimit(event: any): number {
    const direct = [event?.maxFileSize, event?.fileSizeLimit, event?.limits?.fileSize].find(n => Number.isFinite(n)) as number | undefined;
    const fallback = getUserMaxFileSize?.(UserStore.getCurrentUser());
    return Math.max(0, direct ?? fallback ?? 0);
}

function extractFiles(value: any): File[] {
    if (value instanceof File) return [value];
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry: any) => {
        if (entry instanceof File) return [entry];
        if (entry?.file instanceof File) return [entry.file];
        if (entry?.item?.file instanceof File) return [entry.item.file];
        return [];
    });
}

function addToDraft(channelId: string, files: File[]) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return;
    UploadHandler.promptToUpload(files, channel, DraftType.ChannelMessage);
}

async function compressAndAdd(files: File[], limit: number, channelId: string) {
    const target = Math.floor(limit * (1 - settings.store.headroom / 100));

    for (const file of files) {
        if (settings.store.askPermission && !(await confirmCompress(file.name, file.size))) {
            showToast(`${file.name} not sent`, Toasts.Type.MESSAGE);
            continue;
        }
        showToast(`Compressing ${file.name} (${fmt(file.size)})...`, Toasts.Type.MESSAGE);
        try {
            const duration = await getDuration(file);
            if (!duration) {
                showToast(`Couldn't read ${file.name}`, Toasts.Type.FAILURE);
                continue;
            }

            const path = (file as any).path as string | undefined;
            const res = await Native.compress({
                name: file.name,
                path: path || undefined,
                data: path ? undefined : new Uint8Array(await file.arrayBuffer()),
                durationSec: duration,
                targetBytes: target,
                isVideo: isVideoFile(file)
            });

            if (!res.ok) {
                showToast(`${file.name}: ${res.error}`, Toasts.Type.FAILURE);
                continue;
            }

            const out = new File([res.data], `${baseName(file.name)}.${res.ext}`, {
                type: res.ext === "mp4" ? "video/mp4" : "audio/mpeg"
            });

            if (out.size > limit) {
                showToast(`${file.name}: still over the limit after compressing`, Toasts.Type.FAILURE);
                continue;
            }

            ours.add(out);
            addToDraft(channelId, [out]);
            showToast(`${file.name}: ${fmt(file.size)} > ${fmt(out.size)}`, Toasts.Type.SUCCESS);
        } catch (e) {
            logger.error("compression failed for " + file.name, e);
            showToast(`Failed to compress ${file.name}`, Toasts.Type.FAILURE);
        }
    }
}

function onDispatch(event: any) {
    try {
        if (event?.type !== "UPLOAD_ATTACHMENT_ADD_FILES") return;
        if (event.draftType !== DraftType.ChannelMessage) return;

        const files = [
            ...extractFiles(event.files),
            ...extractFiles(event.uploads),
            ...extractFiles(event.items)
        ];
        const unique = Array.from(new Set(files));
        if (!unique.length) return;

        const limit = getLimit(event);
        if (!limit) return;

        const toCompress = unique.filter(f => !ours.has(f) && f.size > limit && isCompressible(f));
        if (!toCompress.length) return;

        const channelId = event.channelId ?? SelectedChannelStore.getChannelId();
        if (!channelId) return;

        const passThrough = unique.filter(f => !toCompress.includes(f));
        event.files = [];
        event.uploads = [];
        event.items = [];

        if (passThrough.length) addToDraft(channelId, passThrough);
        void compressAndAdd(toCompress, limit, channelId);
    } catch (e) {
        logger.error("Interceptor error", e);
    }
}

function resolveLimit(channelId: string): number {
    try {
        if (typeof getGuildAwareMaxFileSize === "function") {
            const guildId = ChannelStore.getChannel(channelId)?.guild_id ?? null;
            const v = getGuildAwareMaxFileSize(guildId);
            if (Number.isFinite(v) && v > 0) return v;
        }
    } catch (e) {
        logger.error("resolveLimit error", e);
    }
    const base = getUserMaxFileSize?.(UserStore.getCurrentUser());
    return Number.isFinite(base) ? base : 0;
}

function handleDomFiles(e: Event, files: File[]) {
    if (!files.length) return;

    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return;

    const limit = resolveLimit(channelId);
    if (!limit) return;

    const toCompress = files.filter(f => !ours.has(f) && f.size > limit && isCompressible(f));
    if (!toCompress.length) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    const passThrough = files.filter(f => !toCompress.includes(f));
    if (passThrough.length) addToDraft(channelId, passThrough);
    void compressAndAdd(toCompress, limit, channelId);
}

function onPaste(e: ClipboardEvent) {
    try {
        handleDomFiles(e, Array.from(e.clipboardData?.files ?? []));
    } catch (err) {
        logger.error("paste handler error", err);
    }
}

function onDrop(e: DragEvent) {
    try {
        handleDomFiles(e, Array.from(e.dataTransfer?.files ?? []));
    } catch (err) {
        logger.error("drop handler error", err);
    }
}

export default definePlugin({
    name: "TheCollective",
    description: "auto-compresses audio and video files down to fit discord's upload limit instead of blocking it. requires ffmpeg on PATH.",
    authors: [{ name: "hypernova", id: 737577969115070571n }],
    settings,

    patches: [
        {
            find: "getGuildMaxFileSize",
            replacement: {
                match: /Array\.from\((\i)\)\.some\(\i=>\i\.size>/g,
                replace: "$self.bypassSizeCheck($1)?false:$&"
            }
        }
    ],

    bypassSizeCheck(files: any): boolean {
        try {
            return Array.from(files ?? []).some((f: any) => {
                const file = f instanceof File ? f : f?.file ?? f?.item?.file;
                return file instanceof File && isCompressible(file);
            });
        } catch (e) {
            logger.error("bypassSizeCheck error", e);
            return false;
        }
    },

    async start() {
        if (!interceptor) {
            interceptor = onDispatch;
            FluxDispatcher.addInterceptor(interceptor);
        }

        if (!pasteHandler) {
            pasteHandler = onPaste;
            document.addEventListener("paste", pasteHandler, true);
        }
        if (!dropHandler) {
            dropHandler = onDrop;
            document.addEventListener("drop", dropHandler, true);
        }

        try {
            if (!(await Native.ffmpegAvailable()))
                showToast("TheCollective: ffmpeg not found. install it and add it to PATH.", Toasts.Type.FAILURE);
        } catch { }
    },

    stop() {
        if (interceptor) {
            const list = (FluxDispatcher as any)._interceptors;
            const i = list?.indexOf(interceptor);
            if (i > -1) list.splice(i, 1);
            interceptor = null;
        }

        if (pasteHandler) {
            document.removeEventListener("paste", pasteHandler, true);
            pasteHandler = null;
        }
        if (dropHandler) {
            document.removeEventListener("drop", dropHandler, true);
            dropHandler = null;
        }
    }
});
