// Infinite Canvas 第三方节点插件：本地语音（Breeze-TTS WebUI）
//
// 链路：画布节点 → 本地桥 http://127.0.0.1:9001 → Gradio http://127.0.0.1:9000
//
// 为什么中间必须有一个桥（实测结论）：
// 1. Gradio 的 /gradio_api/call/* 预检能过，但响应不带 Access-Control-Allow-Origin，
//    从 https 的画布页面直接 fetch 会被浏览器按 CORS 拦掉。
// 2. Gradio 一次调用是三段式（上传文件 → 换 event_id → 读 SSE），放在节点里拼很脆。
// 3. 桥自己回 CORS 头，画布只连桥，不碰 Gradio 的细节。
//
// 节点对应 WebUI 的六个页签：模型配置 / 音色克隆 / 音色设计 / 音色情绪控制 /
// 多角色配音 / SRT 字幕配音，另加一个语音转文字。

const DEFAULT_BRIDGE = "http://127.0.0.1:9001";
const VOICE_PLACEHOLDER = "---下拉选择音色---";
const MAX_BYTES = 30 * 1024 * 1024;

// 2060 6G 上实测 RTF≈36（1.52 秒音频用了 54 秒），写进提示里让用户有预期
const SLOW_HINT = "Breeze 在这台机上很慢（约 30 倍实时），1 秒音频要 30 秒左右，长句请耐心等";

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
        throw new Error("这个音频是画布素材库地址（canvas-assets 禁止跨域），页面抓不到。请点「选本地文件」重新上传一次。");
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

function bridgeBase(url) {
    const base = String(url || DEFAULT_BRIDGE).trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) throw new Error("桥地址要以 http:// 开头，例如 http://127.0.0.1:9001");
    return base;
}

async function getJson(url) {
    const response = await fetch(url, { method: "GET", cache: "no-store" });
    const text = await response.text();
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`返回的不是 JSON（HTTP ${response.status}）：` + text.slice(0, 140));
    }
    return parsed;
}

async function postJson(url, payload) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const text = await response.text();
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`返回的不是 JSON（HTTP ${response.status}）：` + text.slice(0, 140));
    }
    if (!parsed?.ok) throw new Error(parsed?.error || `HTTP ${response.status}`);
    return parsed;
}

const API = {
    health: (bridge) => getJson(bridgeBase(bridge) + "/health"),
    voices: (bridge) => getJson(bridgeBase(bridge) + "/voices"),
    voice: (bridge, name) => getJson(bridgeBase(bridge) + "/voice?name=" + encodeURIComponent(name)),
    asr: (bridge, payload) => postJson(bridgeBase(bridge) + "/asr", payload),
    tts: (bridge, payload) => postJson(bridgeBase(bridge) + "/tts", payload),
    multi: (bridge, payload) => postJson(bridgeBase(bridge) + "/multi", payload),
    srt: (bridge, payload) => postJson(bridgeBase(bridge) + "/srt", payload),
};

const MODES = {
    design: {
        title: "🎨 音色设计",
        desc: "只给文字 + 音色描述，凭空造一个声音",
        cfg: 4,
        needInstruction: true,
    },
    clone: {
        title: "🎙 音色克隆",
        desc: "给一段参考音频，用它的音色念你的文字",
        cfg: 1,
        needRef: true,
    },
    direction: {
        title: "🎛 音色情绪控制",
        desc: "参考音色 + 表达指令（如「压低声音，颤抖地」），复刻语气",
        cfg: 4,
        needRef: true,
        needInstruction: true,
    },
    multi: {
        title: "👥 多角色配音",
        desc: "脚本写成 [角色]: 台词 的形式，一次出多角色对白",
        isMulti: true,
    },
    srt: {
        title: "🎬 SRT 字幕配音",
        desc: "上传 .srt，按字幕时间轴整段配音",
        isSrt: true,
    },
    asr: { title: "🎙 语音转文字" },
};

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
        area: {
            width: "100%",
            boxSizing: "border-box",
            border: `1px solid ${node.stroke || "#ffffff33"}`,
            borderRadius: 8,
            padding: "6px 8px",
            background: "transparent",
            color: node.text || "#eee",
            fontSize: 12,
            outline: "none",
            minHeight: 70,
            resize: "vertical",
            fontFamily: "inherit",
            lineHeight: 1.6,
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
        hint: { color: node.muted || "#999", fontSize: 11, lineHeight: 1.6 },
        row: { display: "flex", gap: 6, alignItems: "center" },
        card: {
            border: `1px solid ${node.stroke || "#ffffff33"}`,
            borderRadius: 8,
            padding: "8px 10px",
            fontSize: 12,
            lineHeight: 1.7,
            maxHeight: 180,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
        },
    };
}

/** 从脚本里解析 [角色]: 台词 的角色名，最多 8 个 */
function parseRoles(script) {
    const names = [];
    const re = /^[ \t]*\[([^\]\r\n]{1,20})\][ \t]*[:：]/gm;
    let m = null;
    while ((m = re.exec(String(script || ""))) !== null) {
        const n = m[1].trim();
        if (n && !names.includes(n)) names.push(n);
        if (names.length >= 8) break;
    }
    return names;
}

function modeOfName(meta) {
    return String(meta?.mode || "design");
}

// ─── 共享 UI ────────────────────────────────────────────

function TtsContent({ ctx, React, mode }) {
    const h = React.createElement;
    const ctxRef = React.useRef(ctx);
    ctxRef.current = ctx;

    const cfgInfo = MODES[mode] || MODES.design;
    const meta = ctx.node?.metadata || {};
    const s = styles(ctx);
    const stop = (event) => event.stopPropagation();

    const [bridgeUrl, setBridgeUrl] = React.useState(meta.bridgeUrl || DEFAULT_BRIDGE);
    const [text, setText] = React.useState(meta.text || "");
    const [instruction, setInstruction] = React.useState(meta.instruction || "");
    const [cfgScale, setCfgScale] = React.useState(Number(meta.cfgScale ?? cfgInfo.cfg ?? 4));
    const [speed, setSpeed] = React.useState(Number(meta.speed ?? 1));
    const [seed, setSeed] = React.useState(Number(meta.seed ?? 42));

    const [refFile, setRefFile] = React.useState(null);
    const [refText, setRefText] = React.useState(meta.refText || "");
    const [voiceName, setVoiceName] = React.useState(meta.voiceName || "");
    const [voicePool, setVoicePool] = React.useState(meta.voicePool || []);
    const [loadedVoice, setLoadedVoice] = React.useState(null);

    const [script, setScript] = React.useState(meta.script || "");
    const [roleConfig, setRoleConfig] = React.useState(meta.roleConfig || {});
    const [srtFile, setSrtFile] = React.useState(null);

    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState(meta.lastStatus || "");
    const [audioUrl, setAudioUrl] = React.useState(meta.audioDataUrl || "");
    const [audioMime, setAudioMime] = React.useState(meta.audioMime || "audio/wav");
    const [note, setNote] = React.useState(meta.note || "");

    const fileRef = React.useRef(null);
    const srtRef = React.useRef(null);

    // 只按签名决定要不要写回，避免 ctx 每次都是新对象导致的无限重渲染
    const signature = JSON.stringify({
        bridgeUrl, text, instruction, cfgScale, speed, seed, refText, voiceName, script, roleConfig, mode,
    });
    React.useEffect(() => {
        const m = ctxRef.current.node?.metadata || {};
        if (m.__sig === signature) return;
        ctxRef.current.updateMetadata?.({
            __sig: signature,
            bridgeUrl, text, instruction, cfgScale, speed, seed, refText, voiceName, script, roleConfig,
        });
    }, [signature]);

    // 需要音色下拉的模式，挂载时拉一次音色列表（失败不打扰用户）
    React.useEffect(() => {
        if (mode !== "srt" && mode !== "clone" && mode !== "multi") return;
        if (Array.isArray(voicePool) && voicePool.length) return;
        API.voices(bridgeUrl)
            .then((r) => {
                if (Array.isArray(r?.voices)) setVoicePool(r.voices);
            })
            .catch(() => null);
    }, []);

    const upstreamAudio = findUpstreamAudio(ctx);
    const roles = parseRoles(script);

    function getRole(name) {
        const item = roleConfig?.[name] || {};
        return { voice: item.voice || VOICE_PLACEHOLDER, speed: Number(item.speed ?? 1) };
    }

    function setRole(name, patch) {
        setRoleConfig((prev) => ({ ...(prev || {}), [name]: { ...getRole(name), ...patch } }));
    }

    async function testBridge() {
        if (busy) return;
        setBusy(true);
        setStatus("正在连桥…");
        try {
            const health = await API.health(bridgeUrl);
            if (!health?.ok) throw new Error(health?.error || "桥没就绪");
            if (!health?.gradio?.ok) throw new Error("桥活着，但连不上 Breeze WebUI：" + (health?.gradio?.error || "未知"));
            setStatus(`桥正常 · WebUI 在线（${health.gradio.endpoints} 个接口）`);
        } catch (error) {
            setStatus("连桥失败：" + String(error?.message || error));
        } finally {
            setBusy(false);
        }
    }

    async function refreshVoices() {
        try {
            const r = await API.voices(bridgeUrl);
            setVoicePool(Array.isArray(r?.voices) ? r.voices : []);
            setStatus(r?.voices?.length ? `音色库 ${r.voices.length} 个` : "音色库是空的，先去 WebUI 里存一个");
        } catch (error) {
            setStatus("读音色库失败：" + String(error?.message || error));
        }
    }

    async function pickVoice(name) {
        setVoiceName(name);
        setLoadedVoice(null);
        if (!name || name === VOICE_PLACEHOLDER) return;
        setStatus("正在载入音色 " + name + "…");
        try {
            const r = await API.voice(bridgeUrl, name);
            setLoadedVoice({ base64: r.audioBase64, mime: r.mime, name });
            if (!refText && r.text) setRefText(r.text);
            setStatus(`已载入音色：${name}`);
        } catch (error) {
            setStatus("载入音色失败：" + String(error?.message || error));
        }
    }

    /** 参考音频：本地文件 > 上游节点 > 音色库 */
    async function resolveRef() {
        if (refFile) {
            if (refFile.size > MAX_BYTES) throw new Error(`参考音频 ${(refFile.size / 1048576).toFixed(1)}MB 太大`);
            return { base64: await blobToBase64(refFile), name: refFile.name || "ref.wav", mime: refFile.type || "audio/wav" };
        }
        if (upstreamAudio) {
            const got = await contentToBlob(upstreamAudio.content, "ref.wav");
            return { base64: await blobToBase64(got.blob), name: got.name || "ref.wav", mime: got.blob.type || "audio/wav" };
        }
        if (loadedVoice?.base64) {
            return { base64: loadedVoice.base64, name: loadedVoice.name || "ref.wav", mime: loadedVoice.mime || "audio/wav" };
        }
        throw new Error("缺参考音频：点「选参考音频」、在左边连一个音频节点，或先从音色库载入一个");
    }

    async function generate() {
        if (busy) return;
        setBusy(true);
        setStatus("正在提交…");
        try {
            let payload = null;
            let runner = null;

            if (cfgInfo.isMulti) {
                if (!String(script || "").trim()) throw new Error("先写配音脚本");
                if (!roles.length) throw new Error("脚本里没有角色，要写成 [张三]: 台词 的形式");
                const names = Array.from({ length: 8 }, (_, i) => roles[i] || "");
                const voices = roles.map((n) => getRole(n).voice).concat(Array(Math.max(0, 8 - roles.length)).fill(VOICE_PLACEHOLDER)).slice(0, 8);
                const speeds = roles.map((n) => getRole(n).speed).concat(Array(Math.max(0, 8 - roles.length)).fill(1)).slice(0, 8);
                payload = { script, seed, roles: names, voices, speeds };
                runner = () => API.multi(bridgeUrl, payload);
            } else if (cfgInfo.isSrt) {
                if (!srtFile) throw new Error("先选一个 .srt 文件");
                payload = {
                    srtBase64: await blobToBase64(srtFile),
                    srtName: srtFile.name || "subtitle.srt",
                    voice: voiceName || VOICE_PLACEHOLDER,
                    seed,
                };
                runner = () => API.srt(bridgeUrl, payload);
            } else {
                payload = {
                    mode,
                    text,
                    instruction,
                    cfgScale,
                    speed,
                    seed,
                };
                if (cfgInfo.needRef) {
                    const ref = await resolveRef();
                    payload.refAudioBase64 = ref.base64;
                    payload.refFilename = ref.name;
                    payload.refMime = ref.mime;
                    payload.refText = refText;
                }
                runner = () => API.tts(bridgeUrl, payload);
            }

            setStatus("生成中…" + SLOW_HINT);
            const result = await runner();
            if (!result?.audioBase64) throw new Error("桥没有返回音频");
            const dataUrl = `data:${result.mime || "audio/wav"};base64,${result.audioBase64}`;
            const kb = Math.round((result.bytes || 0) / 1024);
            setAudioUrl(dataUrl);
            setAudioMime(result.mime || "audio/wav");
            setNote(result.note || "");
            setStatus(`完成 · ${kb}KB · 生成耗时 ${((result.ms || 0) / 1000).toFixed(1)} 秒`);
            ctxRef.current.updateMetadata?.({
                audioDataUrl: dataUrl,
                audioMime: result.mime || "audio/wav",
                note: result.note || "",
                lastStatus: "上次生成完成",
            });
        } catch (error) {
            setStatus(String(error?.message || error));
        } finally {
            setBusy(false);
        }
    }

    function addAudioNode() {
        const node = ctxRef.current.node;
        if (!audioUrl) {
            setStatus("还没有音频");
            return;
        }
        const id = randomId("local-tts-audio");
        const x = (node?.position?.x ?? 0) + (node?.width ?? 380) + 96;
        const y = node?.position?.y ?? 0;
        const title = `${cfgInfo.title.replace(/^[^\u4e00-\u9fa5A-Za-z]+/, "")} · ${String(text || script || "配音").slice(0, 24) || "配音"}`;
        try {
            ctxRef.current.applyOps?.([
                {
                    type: "add_node",
                    id,
                    nodeType: "audio",
                    title,
                    position: { x, y },
                    x,
                    y,
                    width: 360,
                    height: 200,
                    metadata: {
                        content: audioUrl,
                        status: "success",
                        mimeType: audioMime || "audio/wav",
                    },
                },
                { type: "connect_nodes", fromNodeId: node?.id, toNodeId: id },
            ]);
            setStatus("已落成音频节点");
        } catch (error) {
            setStatus("建音频节点失败：" + String(error?.message || error));
        }
    }

    function downloadAudio() {
        if (!audioUrl) return;
        try {
            const a = document.createElement("a");
            a.href = audioUrl;
            a.download = `breeze-${mode}-${Date.now()}.wav`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setStatus("已开始下载");
        } catch (error) {
            setStatus("下载失败：" + String(error?.message || error));
        }
    }

    const rows = [
        h("div", { style: { fontSize: 15, fontWeight: 600 } }, cfgInfo.title),
        h("div", { style: s.hint }, cfgInfo.desc),
        h("div", null, [
            h("div", { style: s.label }, "本地桥地址"),
            h("input", {
                style: s.field,
                type: "text",
                spellCheck: false,
                value: bridgeUrl,
                onMouseDown: stop,
                onChange: (e) => setBridgeUrl(e.target.value.trim()),
            }),
            h("button", { type: "button", style: { ...s.button, marginTop: 4 }, disabled: busy, onMouseDown: stop, onClick: testBridge },
                "测试连接"),
        ]),
    ];

    // 音量 / 文本类字段
    if (cfgInfo.isMulti) {
        rows.push(h("div", null, [
            h("div", { style: s.label }, "配音脚本（每行 [角色]: 台词）"),
            h("textarea", {
                style: s.area,
                value: script,
                onMouseDown: stop,
                onChange: (e) => setScript(e.target.value),
            }),
            h("div", { style: s.hint }, roles.length ? `识别到 ${roles.length} 个角色：${roles.join("、")}` : "还没有角色，按 [张三]: 你好 的格式写"),
        ]));
        if (roles.length) {
            rows.push(h("div", null, [
                h("div", { style: { ...s.label, marginTop: 4 } }, "角色音色"),
                ...roles.map((name) => h("div", { key: name, style: { ...s.row, marginTop: 4 } }, [
                    h("div", { style: { ...s.hint, width: 64, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, name),
                    h("select", {
                        style: { ...s.field, flex: 1 },
                        value: getRole(name).voice,
                        onMouseDown: stop,
                        onChange: (e) => setRole(name, { voice: e.target.value }),
                    }, [
                        h("option", { key: "none", value: VOICE_PLACEHOLDER }, VOICE_PLACEHOLDER),
                        ...voicePool.map((v) => h("option", { key: v, value: v }, v)),
                    ]),
                    h("input", {
                        type: "number",
                        step: "0.1",
                        style: { ...s.field, width: 60, flex: "none" },
                        value: getRole(name).speed,
                        onMouseDown: stop,
                        onChange: (e) => setRole(name, { speed: Number(e.target.value) }),
                    }),
                ])),
            ]));
        }
    } else if (cfgInfo.isSrt) {
        rows.push(h("div", null, [
            h("div", { style: s.label }, "字幕文件"),
            h("input", {
                ref: srtRef,
                type: "file",
                accept: ".srt,text/plain",
                style: { display: "none" },
                onChange: (e) => { setSrtFile(e.target.files?.[0] || null); setStatus(""); },
            }),
            h("button", { type: "button", style: { ...s.button, marginTop: 2 }, onMouseDown: stop, onClick: () => srtRef.current?.click() },
                srtFile ? `换一个（${srtFile.name}）` : "选 .srt 文件"),
        ]));
        rows.push(h("div", null, [
            h("div", { style: { ...s.label, marginTop: 4 } }, "音色"),
            h("select", {
                style: s.field,
                value: voiceName || VOICE_PLACEHOLDER,
                onMouseDown: stop,
                onChange: (e) => setVoiceName(e.target.value),
            }, [
                h("option", { key: "none", value: VOICE_PLACEHOLDER }, VOICE_PLACEHOLDER),
                ...voicePool.map((v) => h("option", { key: v, value: v }, v)),
            ]),
            h("button", { type: "button", style: { ...s.button, marginTop: 4 }, onMouseDown: stop, onClick: refreshVoices }, "刷新音色库"),
        ]));
    } else {
        rows.push(h("div", null, [
            h("div", { style: s.label }, "目标文本"),
            h("textarea", {
                style: s.area,
                value: text,
                placeholder: "要念的内容",
                onMouseDown: stop,
                onChange: (e) => setText(e.target.value),
            }),
        ]));

        if (cfgInfo.needInstruction) {
            rows.push(h("div", null, [
                h("div", { style: s.label }, mode === "direction" ? "表达 / 情绪指令" : "音色描述"),
                h("input", {
                    style: s.field,
                    type: "text",
                    value: instruction,
                    placeholder: mode === "direction" ? "例如：压低声音，带着颤抖" : "例如：年轻女性，语气自然",
                    onMouseDown: stop,
                    onChange: (e) => setInstruction(e.target.value),
                }),
            ]));
        }

        if (cfgInfo.needRef) {
            const refSource = refFile
                ? `本地文件：${refFile.name}`
                : upstreamAudio
                    ? `上游节点：${upstreamAudio.node.title || upstreamAudio.node.id}`
                    : loadedVoice
                        ? `音色库：${loadedVoice.name}`
                        : "还没有参考音频";
            rows.push(h("div", null, [
                h("div", { style: s.label }, "参考音频"),
                h("div", { style: { ...s.hint, marginBottom: 4 } }, refSource),
                h("input", {
                    ref: fileRef,
                    type: "file",
                    accept: "audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac",
                    style: { display: "none" },
                    onChange: (e) => { setRefFile(e.target.files?.[0] || null); setLoadedVoice(null); setStatus(""); },
                }),
                h("div", { style: s.row }, [
                    h("button", { type: "button", style: { ...s.button, flex: 1 }, onMouseDown: stop, onClick: () => fileRef.current?.click() },
                        refFile ? "换文件" : "选参考音频"),
                    h("button", { type: "button", style: { ...s.button, flex: 1 }, onMouseDown: stop, onClick: () => { setRefFile(null); setLoadedVoice(null); setVoiceName(""); } },
                        "清空"),
                ]),
                h("div", { style: { ...s.label, marginTop: 6 } }, "或者从音色库载入"),
                h("select", {
                    style: s.field,
                    value: voiceName || VOICE_PLACEHOLDER,
                    onMouseDown: stop,
                    onChange: (e) => pickVoice(e.target.value),
                }, [
                    h("option", { key: "none", value: VOICE_PLACEHOLDER }, VOICE_PLACEHOLDER),
                    ...voicePool.map((v) => h("option", { key: v, value: v }, v)),
                ]),
                h("button", { type: "button", style: { ...s.button, marginTop: 4 }, onMouseDown: stop, onClick: refreshVoices }, "刷新音色库"),

                h("div", { style: { ...s.label, marginTop: 6 } }, "参考音频对应的文字"),
                h("input", {
                    style: s.field,
                    type: "text",
                    value: refText,
                    placeholder: "参考音频里说了什么（短句，10 秒以内）",
                    onMouseDown: stop,
                    onChange: (e) => setRefText(e.target.value),
                }),
            ]));
        }

        rows.push(h("div", null, [
            h("div", { style: s.row }, [
                h("div", { style: { flex: 1 } }, [
                    h("div", { style: s.label }, "CFG"),
                    h("input", { type: "number", step: "0.1", style: s.field, value: cfgScale, onMouseDown: stop, onChange: (e) => setCfgScale(Number(e.target.value)) }),
                ]),
                h("div", { style: { flex: 1 } }, [
                    h("div", { style: s.label }, "语速"),
                    h("input", { type: "number", step: "0.1", style: s.field, value: speed, onMouseDown: stop, onChange: (e) => setSpeed(Number(e.target.value)) }),
                ]),
                h("div", { style: { flex: 1 } }, [
                    h("div", { style: s.label }, "种子"),
                    h("input", { type: "number", step: "1", style: s.field, value: seed, onMouseDown: stop, onChange: (e) => setSeed(Number(e.target.value)) }),
                ]),
            ]),
        ]));
    }

    rows.push(h("button", {
        type: "button",
        style: { ...s.button, marginTop: 4, fontWeight: 600 },
        disabled: busy,
        onMouseDown: stop,
        onClick: generate,
    }, busy ? "生成中…" : "开始生成"));

    if (status) {
        rows.push(h("div", {
            style: {
                fontSize: 11,
                lineHeight: 1.5,
                color: busy ? "#ffd54f" : /失败|缺|先|没有/.test(status) ? "#ef9a9a" : "#9ccc65",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
            },
        }, status));
    }

    if (audioUrl) {
        rows.push(h("audio", { src: audioUrl, controls: true, style: { width: "100%", marginTop: 2 } }));
        if (note) rows.push(h("div", { style: s.hint }, note));
        rows.push(h("div", { style: { ...s.row, marginTop: 4 } }, [
            h("button", { type: "button", style: { ...s.button, flex: 1 }, onMouseDown: stop, onClick: addAudioNode }, "落成音频节点"),
            h("button", { type: "button", style: { ...s.button, flex: 1 }, onMouseDown: stop, onClick: downloadAudio }, "下载"),
        ]));
        const sizeMB = audioUrl.length / 1048576;
        if (sizeMB > 2) {
            rows.push(h("div", { style: s.hint }, `音频数据约 ${sizeMB.toFixed(1)}MB，存进画布可能吃紧，建议先下载`));
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
    }, rows);
}

function SettingsContent({ ctx, React }) {
    const h = React.createElement;
    const meta = ctx.node?.metadata || {};
    const s = styles(ctx);
    const stop = (event) => event.stopPropagation();
    const ctxRef = React.useRef(ctx);
    ctxRef.current = ctx;

    const [bridgeUrl, setBridgeUrl] = React.useState(meta.bridgeUrl || DEFAULT_BRIDGE);
    const [offload, setOffload] = React.useState(Boolean(meta.offload));
    const [status, setStatus] = React.useState("");

    const signature = JSON.stringify({ bridgeUrl, offload });
    React.useEffect(() => {
        const m = ctxRef.current.node?.metadata || {};
        if (m.__sig === signature) return;
        ctxRef.current.updateMetadata?.({ __sig: signature, bridgeUrl, offload });
    }, [signature]);

    async function check() {
        setStatus("正在连桥…");
        try {
            const health = await API.health(bridgeUrl);
            if (!health?.gradio?.ok) throw new Error("连不上 WebUI：" + (health?.gradio?.error || "未知"));
            let voices = [];
            try {
                voices = (await API.voices(bridgeUrl))?.voices || [];
            } catch {
                voices = [];
            }
            setStatus(`WebUI 在线 · ${health.gradio.endpoints} 个接口 · 音色 ${voices.length} 个${voices.length ? "：" + voices.join("、") : ""}`);
        } catch (error) {
            setStatus("失败：" + String(error?.message || error));
        }
    }

    async function toggleOffload(value) {
        setOffload(value);
        setStatus(value ? "已勾选 offload（对之后所有页签生效）" : "已取消 offload");
        // offload 是 WebUI 的全局开关，走桥转发一次；失败就只记在本地
        try {
            await postJson(bridgeBase(bridgeUrl) + "/offload", { enabled: value });
        } catch {
            // 桥没这个接口就忽略
        }
    }

    return h("div", {
        style: {
            display: "flex", width: "100%", height: "100%", flexDirection: "column",
            gap: 8, padding: 12, boxSizing: "border-box", overflow: "auto", color: ctx.theme.node.text,
        },
    }, [
        h("div", { style: { fontSize: 15, fontWeight: 600 } }, "⚙ 模型配置"),
        h("div", { style: s.hint }, "这里只配它与本地服务怎么连；声音参数在各语音节点的面板里"),
        h("div", null, [
            h("div", { style: s.label }, "本地桥地址"),
            h("input", { style: s.field, type: "text", value: bridgeUrl, onMouseDown: stop, onChange: (e) => setBridgeUrl(e.target.value.trim()) }),
            h("button", { type: "button", style: { ...s.button, marginTop: 4 }, onMouseDown: stop, onClick: check }, "测试连接"),
        ]),
        h("label", { style: { ...s.row, cursor: "pointer", marginTop: 2 } }, [
            h("input", { type: "checkbox", checked: offload, onChange: (e) => toggleOffload(e.target.checked) }),
            h("span", { style: s.hint }, "启用 offload 低显存模式（压低生成峰值显存）"),
        ]),
        status ? h("div", { style: { fontSize: 11, lineHeight: 1.6, color: /失败/.test(status) ? "#ef9a9a" : "#9ccc65", whiteSpace: "pre-wrap" } }, status) : null,
        h("div", { style: s.hint },
            "起服务：先跑 Breeze 的 webui.py（9000），再双击仓库里的「启动桥.bat」（9001）。"),
    ]);
}

function AsrContent({ ctx, React }) {
    const h = React.createElement;
    const ctxRef = React.useRef(ctx);
    ctxRef.current = ctx;

    const meta = ctx.node?.metadata || {};
    const s = styles(ctx);
    const stop = (event) => event.stopPropagation();

    const [bridgeUrl, setBridgeUrl] = React.useState(meta.bridgeUrl || DEFAULT_BRIDGE);
    const [picked, setPicked] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState(meta.lastStatus || "");
    const [result, setResult] = React.useState(meta.result || "");
    const [ms, setMs] = React.useState(meta.ms ?? null);
    const fileRef = React.useRef(null);

    const signature = JSON.stringify({ bridgeUrl });
    React.useEffect(() => {
        const m = ctxRef.current.node?.metadata || {};
        if (m.__sig === signature) return;
        ctxRef.current.updateMetadata?.({ __sig: signature, bridgeUrl });
    }, [signature]);

    const upstreamAudio = findUpstreamAudio(ctx);

    async function testBridge() {
        if (busy) return;
        setBusy(true);
        setStatus("正在连桥…");
        try {
            const health = await API.health(bridgeUrl);
            if (!health?.gradio?.ok) throw new Error("连不上 WebUI：" + (health?.gradio?.error || "未知"));
            setStatus(`桥正常 · WebUI 在线（${health.gradio.endpoints} 个接口）`);
        } catch (error) {
            setStatus("连桥失败：" + String(error?.message || error));
        } finally {
            setBusy(false);
        }
    }

    async function resolveAudio() {
        if (picked) {
            if (picked.size > MAX_BYTES) throw new Error(`文件 ${(picked.size / 1048576).toFixed(1)}MB 超过上限`);
            return { base64: await blobToBase64(picked), name: picked.name || "audio.wav", mime: picked.type || "audio/wav" };
        }
        if (!upstreamAudio) throw new Error("没有音频：先在左边连一个音频节点，或点「选本地文件」");
        const title = `${upstreamAudio.node.title || "audio"}`.replace(/[\\/:*?"<>|]/g, "_");
        const wantName = /\.[a-z0-9]{2,5}$/i.test(title) ? title : `${title}.mp3`;
        const got = await contentToBlob(upstreamAudio.content, wantName);
        return { base64: await blobToBase64(got.blob), name: wantName, mime: got.blob.type || "audio/mpeg" };
    }

    async function run() {
        if (busy) return;
        setBusy(true);
        setStatus("正在转写…");
        try {
            const audio = await resolveAudio();
            const r = await API.asr(bridgeUrl, { audioBase64: audio.base64, filename: audio.name, mime: audio.mime });
            const text = String(r.text || "").trim();
            setResult(text);
            setMs(r.ms ?? null);
            setStatus(text ? `完成 · 耗时 ${r.ms ?? "?"}ms` : "接口通了，但没识别出文字（音频里可能没有人声）");
            ctxRef.current.updateMetadata?.({ result: text, ms: r.ms ?? null, fileName: audio.name, lastStatus: "上次转写完成" });
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
        const id = randomId("local-tts-text");
        const x = (node?.position?.x ?? 0) + (node?.width ?? 380) + 96;
        const y = node?.position?.y ?? 0;
        const title = `转写 · ${String(meta.fileName || "音频").slice(0, 40)}`;
        try {
            ctxRef.current.applyOps?.([
                {
                    type: "add_node", id, nodeType: "text", title,
                    position: { x, y }, x, y, width: 380, height: 240,
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
            display: "flex", width: "100%", height: "100%", flexDirection: "column",
            alignItems: "stretch", gap: 8, padding: 12, boxSizing: "border-box",
            overflow: "auto", color: ctx.theme.node.text,
        },
    }, [
        h("div", { style: { fontSize: 15, fontWeight: 600 } }, MODES.asr.title + " · 本地 Breeze"),
        h("div", { style: s.hint }, "走本机 Breeze WebUI（127.0.0.1:9000），不联网"),
        h("div", null, [
            h("div", { style: s.label }, "本地桥地址"),
            h("input", { style: s.field, type: "text", value: bridgeUrl, onMouseDown: stop, onChange: (e) => setBridgeUrl(e.target.value.trim()) }),
            h("button", { type: "button", style: { ...s.button, marginTop: 4 }, disabled: busy, onMouseDown: stop, onClick: testBridge }, "测试连接"),
        ]),
        h("div", null, [
            h("div", { style: s.label }, "音频"),
            h("div", { style: { ...s.hint, marginBottom: 4 } },
                picked ? `本地文件：${picked.name}（${(picked.size / 1048576).toFixed(2)}MB）`
                    : upstreamAudio ? `上游节点：${upstreamAudio.node.title || upstreamAudio.node.id}`
                        : "未连接音频节点"),
            h("input", {
                ref: fileRef, type: "file", accept: "audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm",
                style: { display: "none" },
                onChange: (e) => { setPicked(e.target.files?.[0] || null); setStatus(""); },
            }),
            h("button", { type: "button", style: { ...s.button, marginTop: 2 }, onMouseDown: stop, onClick: () => fileRef.current?.click() },
                picked ? "换一个文件" : "选本地文件"),
            picked ? h("button", {
                type: "button", style: { ...s.button, marginTop: 4, borderColor: "#ffffff22" }, onMouseDown: stop,
                onClick: () => { setPicked(null); if (fileRef.current) fileRef.current.value = ""; },
            }, "改用上游节点") : null,
        ]),
        h("button", { type: "button", style: { ...s.button, marginTop: 4, fontWeight: 600 }, disabled: busy, onMouseDown: stop, onClick: run },
            busy ? "转写中…" : "开始转写"),
        status ? h("div", {
            style: { fontSize: 11, lineHeight: 1.5, color: busy ? "#ffd54f" : /失败|没识别|先|没有/.test(status) ? "#ef9a9a" : "#9ccc65", whiteSpace: "pre-wrap", wordBreak: "break-word" },
        }, status) : null,
        result ? h("div", null, [
            h("div", { style: s.label }, "转写结果"),
            h("div", { style: s.card }, result),
            h("div", { style: { ...s.row, marginTop: 6 } }, [
                h("button", { type: "button", style: { ...s.button, flex: 1 }, onMouseDown: stop, onClick: addTextNode }, "落成文本节点"),
                h("button", { type: "button", style: { ...s.button, flex: 1 }, onMouseDown: stop, onClick: copyResult }, "复制"),
            ]),
        ]) : null,
        ms ? h("div", { style: s.hint }, `上次耗时：${ms}ms`) : null,
    ]);
}

function node(mode, extra) {
    const info = MODES[mode];
    return {
        type: `local-tts:${mode}`,
        title: info.title,
        icon: Array.from(info.title)[0] || "🎵",
        description: info.desc,
        defaultSize: { width: 380, height: mode === "multi" ? 620 : mode === "srt" ? 460 : 520 },
        defaultMetadata: Object.assign({ bridgeUrl: DEFAULT_BRIDGE, mode }, extra || {}),
        hasSourceHandle: true,
        hidePanel: true,
    };
}

export default function createLocalTtsPlugin(runtime) {
    const React = runtime.React;

    return {
        id: "local-tts",
        name: "本地语音（Breeze-TTS）",
        version: "0.2.0",
        minAppVersion: "0.12.0",
        description: "把本机 Breeze-TTS WebUI 接进画布：转写、克隆、设计、情绪、多角色、SRT。",
        nodes: [
            {
                type: "local-tts:settings",
                title: "语音服务配置",
                icon: "⚙",
                description: "桥地址、连通性、低显存开关",
                defaultSize: { width: 380, height: 320 },
                defaultMetadata: { bridgeUrl: DEFAULT_BRIDGE, offload: false },
                hasSourceHandle: false,
                hidePanel: true,
                Content: (props) => SettingsContent({ ...props, React }),
            },
            {
                type: "local-tts:asr",
                title: MODES.asr.title,
                icon: "🎙",
                description: "音频 → 文字，结果落成文本节点",
                defaultSize: { width: 380, height: 500 },
                defaultMetadata: { bridgeUrl: DEFAULT_BRIDGE, result: "" },
                hasSourceHandle: true,
                hidePanel: true,
                Content: (props) => AsrContent({ ...props, React }),
            },
            ...["clone", "design", "direction", "multi", "srt"].map((mode) => ({
                ...node(mode),
                Content: (props) => TtsContent({ ...props, React, mode }),
            })),
        ],
    };
}
