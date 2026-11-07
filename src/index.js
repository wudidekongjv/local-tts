// Infinite Canvas 第三方节点插件：本地语音转文字（Breeze-TTS WebUI）
//
// 链路：画布节点 → 本地桥 http://127.0.0.1:9001/asr → Gradio http://127.0.0.1:9000
//
// 为什么中间必须有一个桥（实测结论，不是设计偏好）：
// 1. Gradio 的 /gradio_api/call/* 预检能过，但响应不带 Access-Control-Allow-Origin，
//    从 https 的画布页面直接 fetch 会被浏览器按 CORS 拦掉。
// 2. Gradio 一次调用是三段式（上传文件 → 换 event_id → 读 SSE），放在节点里拼很脆。
// 3. 桥自己回 CORS 头，画布只连桥，不碰 Gradio 的细节。
//
// 音频来源：本地文件是主路径。画布素材库是 canvas-assets（DenyCors），
// 页面 fetch 不到，所以「上游节点」只在 content 是 data:/blob: 时可靠。

const DEFAULT_BRIDGE = "http://127.0.0.1:9001";
const MAX_BYTES = 30 * 1024 * 1024; // base64 走 JSON，太大不划算

function randomId(prefix) {
    try {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
            return `${prefix}-${crypto.randomUUID()}`;
        }
    } catch {
        // 老浏览器兜底
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isAudioNode(node) {
    if (!node) return false;
    const mime = String(node?.metadata?.mimeType || "").toLowerCase();
    if (mime.startsWith("audio/")) return true;
    const type = String(node?.type || "");
    if (type === "audio" || type.endsWith(":audio")) return true;
    const content = String(node?.metadata?.content || "");
    return /^data:audio\//i.test(content) || /\.(mp3|wav|m4a|aac|ogg|flac|webm)(\?|#|$)/i.test(content);
}

function findUpstreamAudio(ctx) {
    let list = [];
    try {
        list = ctx.getUpstream?.() || [];
    } catch {
        list = [];
    }
    for (const node of list) {
        if (node?.id === ctx.node?.id) continue;
        if (!isAudioNode(node)) continue;
        const content = node?.metadata?.content;
        if (typeof content === "string" && content.trim()) {
            return { node, content: content.trim() };
        }
    }
    return null;
}

async function contentToBlob(content, name) {
    const isHttp = /^https?:/i.test(content);
    let response;
    try {
        response = await fetch(content, isHttp ? { mode: "cors", credentials: "omit" } : undefined);
    } catch {
        throw new Error("这个音频是画布素材库地址（canvas-assets 禁止跨域），页面抓不到。请点下面的「选本地文件」重新上传一次。");
    }
    if (!response.ok) throw new Error(`读取音频失败：HTTP ${response.status}`);
    return { blob: await response.blob(), name };
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const text = String(reader.result || "");
            const comma = text.indexOf(",");
            resolve(comma >= 0 ? text.slice(comma + 1) : text);
        };
        reader.onerror = () => reject(new Error("读取文件失败"));
        reader.readAsDataURL(blob);
    });
}

async function pingBridge(bridgeUrl) {
    const base = String(bridgeUrl || DEFAULT_BRIDGE).replace(/\/+$/, "");
    const response = await fetch(base + "/health", { method: "GET", cache: "no-store" });
    const body = await response.text();
    let json = null;
    try {
        json = JSON.parse(body);
    } catch {
        throw new Error("桥返回的不是 JSON：" + body.slice(0, 120));
    }
    if (!json?.ok) throw new Error(json?.error || "桥没就绪");
    if (!json?.gradio?.ok) throw new Error("桥活着，但连不上 Breeze WebUI：" + (json?.gradio?.error || "未知"));
    return json;
}

async function callBridgeAsr({ bridgeUrl, base64, filename, mime }) {
    const base = String(bridgeUrl || DEFAULT_BRIDGE).replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) throw new Error("桥地址要以 http:// 开头，例如 http://127.0.0.1:9001");
    const response = await fetch(base + "/asr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioBase64: base64, filename, mime }),
    });
    const text = await response.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        throw new Error(`桥返回了非 JSON（HTTP ${response.status}）：` + text.slice(0, 140));
    }
    if (!json?.ok) throw new Error(json?.error || `HTTP ${response.status}`);
    return json;
}

function styles(ctx) {
    const node = ctx?.theme?.node || {};
    return {
        field: {
            width: "100%",
            boxSizing: "border-box",
            border: `1px solid ${node.stroke || "#ffffff33"}`,
            borderRadius: 8,
            padding: "6px 8px",
            background: "transparent",
            color: node.text || "#eee",
            fontSize: 12,
            outline: "none",
        },
        label: { color: node.muted || "#999", fontSize: 11, marginBottom: 2 },
        button: {
            border: `1px solid ${node.stroke || "#ffffff33"}`,
            borderRadius: 8,
            padding: "7px 10px",
            background: "transparent",
            color: node.text || "#eee",
            fontSize: 12,
            cursor: "pointer",
            width: "100%",
        },
    };
}

function AsrContent({ ctx, React }) {
    const h = React.createElement;
    const ctxRef = React.useRef(ctx);
    ctxRef.current = ctx;

    const meta = ctx.node?.metadata || {};
    const [bridgeUrl, setBridgeUrl] = React.useState(meta.bridgeUrl || DEFAULT_BRIDGE);
    const [picked, setPicked] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState(meta.lastStatus || "");
    const [result, setResult] = React.useState(meta.result || "");
    const [ms, setMs] = React.useState(meta.ms ?? null);
    const fileRef = React.useRef(null);

    // 只在值真的变了才写回，避免「写 metadata → 重渲染 → 再写」死循环
    React.useEffect(() => {
        const m = ctxRef.current.node?.metadata || {};
        if (m.bridgeUrl === bridgeUrl) return;
        ctxRef.current.updateMetadata?.({ bridgeUrl });
    }, [bridgeUrl]);

    const upstreamAudio = findUpstreamAudio(ctx);
    const s = styles(ctx);
    const stop = (event) => event.stopPropagation();

    async function resolveAudio() {
        if (picked) {
            if (picked.size > MAX_BYTES) {
                throw new Error(`文件 ${(picked.size / 1048576).toFixed(1)}MB，超过 ${MAX_BYTES / 1048576}MB 上限`);
            }
            const base64 = await blobToBase64(picked);
            return { base64, name: picked.name || "audio.wav", mime: picked.type || "audio/wav" };
        }
        if (!upstreamAudio) throw new Error("没有音频：先在左边连一个音频节点，或点「选本地文件」");
        const title = `${upstreamAudio.node.title || "audio"}`.replace(/[\\/:*?"<>|]/g, "_");
        const wantName = /\.[a-z0-9]{2,5}$/i.test(title) ? title : `${title}.mp3`;
        const got = await contentToBlob(upstreamAudio.content, wantName);
        const base64 = await blobToBase64(got.blob);
        return { base64, name: wantName, mime: got.blob.type || "audio/mpeg" };
    }

    async function testBridge() {
        if (busy) return;
        setBusy(true);
        setStatus("正在连桥…");
        try {
            const health = await pingBridge(bridgeUrl);
            setStatus(`桥正常 · WebUI 在线（${health.gradio.endpoints} 个接口）`);
        } catch (error) {
            setStatus("连桥失败：" + String(error?.message || error));
        } finally {
            setBusy(false);
        }
    }

    async function run() {
        if (busy) return;
        setBusy(true);
        setStatus("正在转写…（首次加载模型会慢一些）");
        try {
            const audio = await resolveAudio();
            const r = await callBridgeAsr({
                bridgeUrl,
                base64: audio.base64,
                filename: audio.name,
                mime: audio.mime,
            });
            const text = String(r.text || "").trim();
            setResult(text);
            setMs(r.ms ?? null);
            setStatus(text ? `完成 · 耗时 ${r.ms ?? "?"}ms` : "接口通了，但没识别出文字（音频里可能没有人声）");
            ctxRef.current.updateMetadata?.({
                result: text,
                ms: r.ms ?? null,
                fileName: audio.name,
                lastStatus: "上次转写完成",
            });
        } catch (error) {
            setStatus(String(error?.message || error));
        } finally {
            setBusy(false);
        }
    }

    function addTextNode() {
        const node = ctxRef.current.node;
        const text = String(result || "").trim();
        if (!text) {
            setStatus("还没有转写结果");
            return;
        }
        const id = randomId("local-asr-text");
        const x = (node?.position?.x ?? 0) + (node?.width ?? 380) + 96;
        const y = node?.position?.y ?? 0;
        const title = `转写 · ${String(meta.fileName || "音频").slice(0, 40)}`;
        try {
            ctxRef.current.applyOps?.([
                {
                    type: "add_node",
                    id,
                    nodeType: "text",
                    title,
                    position: { x, y },
                    x,
                    y,
                    width: 380,
                    height: 240,
                    metadata: { content: text, status: "success" },
                },
                { type: "connect_nodes", fromNodeId: node?.id, toNodeId: id },
            ]);
            setStatus("已落成文本节点");
        } catch (error) {
            setStatus("建文本节点失败：" + String(error?.message || error));
        }
    }

    async function copyResult() {
        try {
            await navigator.clipboard.writeText(String(result || ""));
            setStatus("已复制");
        } catch {
            setStatus("复制失败，手动选中吧");
        }
    }

    return h("div", {
        style: {
            display: "flex",
            width: "100%",
            height: "100%",
            flexDirection: "column",
            alignItems: "stretch",
            gap: 8,
            padding: 12,
            boxSizing: "border-box",
            overflow: "auto",
            color: ctx.theme.node.text,
        },
    },
    h("div", { style: { fontSize: 15, fontWeight: 600 } }, "🎙 语音转文字 · 本地 Breeze"),
    h("div", { style: { color: ctx.theme.node.muted, fontSize: 11, lineHeight: 1.6 } },
        "走本机 Breeze WebUI（127.0.0.1:9000），不联网、不传云端"),

    h("div", null,
        h("div", { style: s.label }, "本地桥地址"),
        h("input", {
            style: s.field,
            type: "text",
            spellCheck: false,
            placeholder: DEFAULT_BRIDGE,
            value: bridgeUrl,
            onMouseDown: stop,
            onChange: (event) => setBridgeUrl(event.target.value.trim()),
        })),
    h("button", {
        type: "button",
        style: { ...s.button, marginTop: 2 },
        disabled: busy,
        onMouseDown: stop,
        onClick: testBridge,
    }, "测试连接"),

    h("div", { style: { marginTop: 4 } },
        h("div", { style: s.label }, "音频"),
        h("div", { style: { color: ctx.theme.node.muted, fontSize: 11, marginBottom: 4 } },
            picked ? `本地文件：${picked.name}（${(picked.size / 1048576).toFixed(2)}MB）`
                : upstreamAudio ? `上游节点：${upstreamAudio.node.title || upstreamAudio.node.id}`
                    : "未连接音频节点"),

        h("input", {
            ref: fileRef,
            type: "file",
            accept: "audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm",
            style: { display: "none" },
            onChange: (event) => {
                const f = event.target.files?.[0] || null;
                setPicked(f);
                setStatus("");
            },
        }),
        h("button", {
            type: "button",
            style: { ...s.button, marginTop: 2 },
            onMouseDown: stop,
            onClick: () => fileRef.current?.click(),
        }, picked ? "换一个文件" : "选本地文件"),
        picked ? h("button", {
            type: "button",
            style: { ...s.button, marginTop: 4, borderColor: "#ffffff22" },
            onMouseDown: stop,
            onClick: () => { setPicked(null); if (fileRef.current) fileRef.current.value = ""; },
        }, "改用上游节点") : null),

    h("button", {
        type: "button",
        style: { ...s.button, marginTop: 4, fontWeight: 600 },
        disabled: busy,
        onMouseDown: stop,
        onClick: run,
    }, busy ? "转写中…" : "开始转写"),

    status ? h("div", {
        style: {
            fontSize: 11,
            lineHeight: 1.5,
            color: busy ? "#ffd54f" : /失败|没识别|不能|先在/.test(status) ? "#ef9a9a" : "#9ccc65",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
        },
    }, status) : null,

    result ? h("div", null,
        h("div", { style: s.label }, "转写结果"),
        h("div", {
            style: {
                border: `1px solid ${ctx.theme.node.stroke}`,
                borderRadius: 8,
                padding: "8px 10px",
                fontSize: 12,
                lineHeight: 1.7,
                maxHeight: 180,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
            },
        }, result),
        h("div", { style: { display: "flex", gap: 6, marginTop: 6 } },
            h("button", {
                type: "button",
                style: { ...s.button, flex: 1 },
                onMouseDown: stop,
                onClick: addTextNode,
            }, "落成文本节点"),
            h("button", {
                type: "button",
                style: { ...s.button, flex: 1 },
                onMouseDown: stop,
                onClick: copyResult,
            }, "复制"))) : null,

    ms ? h("div", { style: { fontSize: 11, color: ctx.theme.node.muted } }, `上次耗时：${ms}ms`) : null,
    );
}

export default function createLocalTtsPlugin(runtime) {
    const React = runtime.React;
    return {
        id: "local-asr",
        name: "本地语音转文字（Breeze）",
        version: "0.1.0",
        minAppVersion: "0.12.0",
        description: "把音频交给本机 Breeze-TTS WebUI 转写，结果落成文本节点。",
        nodes: [
            {
                type: "local-asr:transcribe",
                title: "本地转写",
                icon: "🎙",
                description: "本地桥 → Breeze WebUI → 文本节点",
                defaultSize: { width: 380, height: 500 },
                defaultMetadata: {
                    bridgeUrl: DEFAULT_BRIDGE,
                    result: "",
                },
                hasSourceHandle: true,
                hidePanel: true,
                Content: (props) => AsrContent({ ...props, React }),
            },
        ],
    };
}
