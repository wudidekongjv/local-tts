// Breeze-TTS 本地桥：把本地 Gradio 服务包装成「允许跨域」的简单接口给无限画布用。
//
// 为什么需要它（三条实测结论）：
// 1. Gradio 的 /gradio_api/call/* 预检通过了，但响应里不带 Access-Control-Allow-Origin，
//    从 https 的画布页面直接 fetch 会被浏览器按 CORS 拦掉。
// 2. Gradio 的真实调用是三段式：先 /gradio_api/upload 上传文件拿临时路径，
//    再 POST /gradio_api/call/<api> 换 event_id，最后 GET .../<event_id> 读 SSE。
// 3. 桥自己回 CORS 头，画布页面只连桥，不碰 Gradio 的细节。
//
// 用法：node bridge/breeze_bridge.mjs
// 环境变量：BREEZE_BASE（默认 http://127.0.0.1:9000）、BRIDGE_PORT（默认 9001）
//
// 接口：
//   GET  /health              探活，回 Gradio 端点数 / 音色数
//   GET  /voices              音色列表（voices 目录）
//   POST /asr                 {audioBase64, filename, mime} → 文本
//   POST /tts                 {mode: design|clone|direction, ...} → 音频
//   POST /multi               {script, roles[], voices[], speeds[], seed} → 音频
//   POST /srt                 {srtBase64, srtName, voice, seed} → 音频

import http from "node:http";
import fs from "node:fs/promises";

const GRADIO = (process.env.BREEZE_BASE || "http://127.0.0.1:9000").replace(/\/+$/, "");
const PORT = Number(process.env.BRIDGE_PORT || 9001);
const ASR_API = process.env.BREEZE_ASR_API || "auto_transcribe";

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
};

function json(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    res.writeHead(status, { ...CORS, "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
    res.end(body);
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
}

/** 把 Gradio 的 SSE 文本解成最终 data（只看 event: complete 之后那一行） */
function parseSSE(raw) {
    let armed = false;
    let payload = null;
    let sawError = false;
    for (const line of raw.split(/\r?\n/)) {
        const s = line.trim();
        if (s.startsWith("event:")) {
            const name = s.slice(6).trim();
            armed = name === "complete";
            if (name === "error") sawError = true;
            continue;
        }
        if (armed && s.startsWith("data:")) {
            payload = s.slice(5).trim();
            armed = false;
        }
    }
    if (payload === null) {
        return { ok: false, error: sawError ? "Gradio 返回 error 事件（多半是参数不对或文件读不到）" : "没有收到 complete 事件" };
    }
    try {
        return { ok: true, data: JSON.parse(payload) };
    } catch {
        return { ok: false, error: "complete 的 data 不是 JSON：" + payload.slice(0, 160) };
    }
}

async function uploadToGradio(blob, filename) {
    const form = new FormData();
    form.append("files", blob, filename);
    const response = await fetch(`${GRADIO}/gradio_api/upload`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`上传失败 HTTP ${response.status}`);
    const paths = await response.json();
    if (!Array.isArray(paths) || !paths[0]) throw new Error("上传没有返回文件路径");
    return paths[0];
}

async function callGradio(api, data, timeoutMs = 600000) {
    const started = Date.now();
    const response = await fetch(`${GRADIO}/gradio_api/call/${api}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
        signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`call/${api} HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
    const { event_id: eventId } = await response.json();
    if (!eventId) throw new Error(`call/${api} 没有返回 event_id`);

    const sse = await fetch(`${GRADIO}/gradio_api/call/${api}/${eventId}`, {
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!sse.ok) throw new Error(`读取结果 HTTP ${sse.status}`);
    const raw = await sse.text();
    const parsed = parseSSE(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    return { data: parsed.data, ms: Date.now() - started };
}

function toFileData(path, filename) {
    return { path, orig_name: filename, meta: { _type: "gradio.FileData" } };
}

function safeName(name, fallback) {
    return String(name || fallback).replace(/[\\/:*?"<>|]/g, "_");
}

async function uploadBase64(base64, filename, mime) {
    const raw = Buffer.from(String(base64), "base64");
    if (!raw.length) throw new Error("上传的文件解码后是空的");
    const name = safeName(filename, "upload.bin");
    const path = await uploadToGradio(new Blob([raw], { type: mime || "application/octet-stream" }), name);
    return { path, name, bytes: raw.length };
}

async function audioToBuffer(value) {
    if (!value) throw new Error("Gradio 没有返回音频");
    let path = "";
    if (typeof value === "string") path = value;
    else if (typeof value === "object") path = value.path || value.name || "";
    if (!path) throw new Error("返回结构里找不到音频路径：" + JSON.stringify(value).slice(0, 200));
    try {
        return { buffer: await fs.readFile(path), path };
    } catch {
        const url = typeof value === "object" ? value.url : "";
        if (!url) throw new Error("音频文件读不到，也没有可下载的 url");
        const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`下载音频 HTTP ${response.status}`);
        return { buffer: Buffer.from(await response.arrayBuffer()), path };
    }
}

async function finishAudio(result) {
    const values = Array.isArray(result.data) ? result.data : [];
    const audio = await audioToBuffer(values[0]);
    const note = typeof values[1] === "string" ? values[1] : "";
    return {
        audioBase64: audio.buffer.toString("base64"),
        mime: /\.mp3$/i.test(audio.path) ? "audio/mpeg" : "audio/wav",
        filename: audio.path.split(/[\\/]/).pop() || "tts.wav",
        bytes: audio.buffer.length,
        ms: result.ms,
        note,
    };
}

// ─── 业务 ───────────────────────────────────────────────

async function handleAsr(payload) {
    const { audioBase64, filename, mime } = payload || {};
    if (!audioBase64) throw new Error("缺少 audioBase64");
    const raw = Buffer.from(String(audioBase64), "base64");
    if (!raw.length) throw new Error("音频解码后是空的");
    const name = safeName(filename, "audio.wav");
    const blob = new Blob([raw], { type: mime || "audio/wav" });
    const remotePath = await uploadToGradio(blob, name);
    const result = await callGradio(ASR_API, [toFileData(remotePath, name)]);
    const value = Array.isArray(result.data) ? result.data[0] : result.data;
    const text = typeof value === "string" ? value : "";
    return { text, ms: result.ms, bytes: raw.length, api: ASR_API };
}

async function handleTts(payload) {
    const body = payload || {};
    const mode = String(body.mode || "design");
    const text = String(body.text || "").trim();
    if (!text) throw new Error("缺少要朗读的文本");

    const cfgScale = Number(body.cfgScale ?? (mode === "clone" ? 1 : 4));
    const speed = Number(body.speed ?? 1);
    const seed = Number(body.seed ?? 42);

    if (mode === "clone") {
        if (!body.refAudioBase64) throw new Error("克隆模式需要一段参考音频");
        const ref = await uploadBase64(body.refAudioBase64, body.refFilename || "ref.wav", body.refMime || "audio/wav");
        const result = await callGradio("do_voice_clone", [
            text,
            toFileData(ref.path, ref.name),
            String(body.refText || ""),
            cfgScale,
            speed,
            seed,
        ], 1800000);
        return finishAudio(result);
    }

    if (mode === "direction") {
        if (!body.refAudioBase64) throw new Error("情绪模式需要一段参考音频");
        const ref = await uploadBase64(body.refAudioBase64, body.refFilename || "ref.wav", body.refMime || "audio/wav");
        const dual = Boolean(body.useDual);
        const result = await callGradio("do_voice_direction", [
            text,
            toFileData(ref.path, ref.name),
            String(body.refText || ""),
            String(body.instruction || ""),
            cfgScale,
            speed,
            seed,
            dual,
            Number(body.cfgRef ?? 4),
            Number(body.cfgIns ?? 4),
        ], 1800000);
        return finishAudio(result);
    }

    // 默认：音色设计，不需要参考音频
    const result = await callGradio("do_voice_design", [
        text,
        String(body.instruction || ""),
        cfgScale,
        speed,
        seed,
    ], 1800000);
    return finishAudio(result);
}

/** 多角色：脚本解析出角色名，按角色给音色与语速，补满 8 组 */
async function handleMulti(payload) {
    const body = payload || {};
    const script = String(body.script || "").trim();
    if (!script) throw new Error("缺少配音脚本");
    const seed = Number(body.seed ?? 42);

    const names = Array.from({ length: 8 }, (_, i) => String(body.roles?.[i] || ""));
    const voices = Array.from({ length: 8 }, (_, i) => String(body.voices?.[i] || "---下拉选择音色---"));
    const speeds = Array.from({ length: 8 }, (_, i) => Number(body.speeds?.[i] ?? 1));

    const data = [script, seed, ...names, ...voices, ...speeds];
    const result = await callGradio("do_multi_role", data, 1800000);
    return finishAudio(result);
}

/** SRT 字幕配音：上传 .srt，按时间轴生成整段音频 */
async function handleSrt(payload) {
    const body = payload || {};
    if (!body.srtBase64) throw new Error("缺少 SRT 文件内容");
    const srt = await uploadBase64(body.srtBase64, body.srtName || "subtitle.srt", "text/plain");
    const voice = String(body.voice || "---下拉选择音色---");
    const seed = Number(body.seed ?? 42);
    const result = await callGradio("do_srt", [toFileData(srt.path, srt.name), voice, seed], 1800000);
    return finishAudio(result);
}

async function handleVoices() {
    const result = await callGradio("lambda_32", [], 30000);
    const value = Array.isArray(result.data) ? result.data[0] : null;
    const choices = value?.choices || [];
    const names = choices
        .map((c) => (Array.isArray(c) ? c[1] : c))
        .filter((n) => typeof n === "string" && n && !n.startsWith("---"));
    return { voices: names };
}

/** 取某个内置音色（voices 目录）的参考音频与参考文本 */
async function handleVoice(name) {
    if (!name) throw new Error("缺少音色名");
    const result = await callGradio("load_voice", [String(name)], 180000);
    const values = Array.isArray(result.data) ? result.data : [];
    const audio = await audioToBuffer(values[0]);
    return {
        audioBase64: audio.buffer.toString("base64"),
        mime: /\.mp3$/i.test(audio.path) ? "audio/mpeg" : "audio/wav",
        text: typeof values[1] === "string" ? values[1] : "",
        ms: result.ms,
    };
}

/** 低显存模式开关：对之后所有页签生效 */
async function handleOffload(payload) {
    const enabled = Boolean(payload?.enabled);
    const result = await callGradio("on_toggle_offload", [enabled], 60000);
    const note = Array.isArray(result.data) ? String(result.data[0] || "") : "";
    return { enabled, note, ms: result.ms };
}

async function checkGradio() {
    try {
        const response = await fetch(`${GRADIO}/gradio_api/info`, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
        const info = await response.json();
        const endpoints = Object.keys(info.named_endpoints || {});
        return { ok: true, endpoints: endpoints.length, asr: endpoints.some((n) => n.includes(ASR_API)), base: GRADIO };
    } catch (error) {
        return { ok: false, error: String(error?.message || error), base: GRADIO };
    }
}

const ROUTES = {
    post: {
        "/asr": handleAsr,
        "/tts": handleTts,
        "/multi": handleMulti,
        "/srt": handleSrt,
        "/offload": handleOffload,
    },
};

const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        res.end();
        return;
    }

    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    const route = url.pathname.replace(/\/+$/, "") || "/";

    try {
        if (req.method === "GET" && route === "/health") {
            const gradio = await checkGradio();
            json(res, 200, { ok: true, bridge: true, port: PORT, gradio, asrApi: ASR_API });
            return;
        }
        if (req.method === "GET" && route === "/voices") {
            json(res, 200, { ok: true, ...(await handleVoices()) });
            return;
        }
        if (req.method === "GET" && route === "/voice") {
            json(res, 200, { ok: true, ...(await handleVoice(url.searchParams.get("name") || "")) });
            return;
        }
        const handler = req.method === "POST" ? ROUTES.post[route] : null;
        if (handler) {
            const raw = await readBody(req);
            let payload = {};
            try {
                payload = JSON.parse(raw.toString("utf8") || "{}");
            } catch {
                json(res, 400, { ok: false, error: "请求体不是合法 JSON" });
                return;
            }
            json(res, 200, { ok: true, ...(await handler(payload)) });
            return;
        }
        json(res, 404, { ok: false, error: "没有这个接口：" + route });
    } catch (error) {
        json(res, 500, { ok: false, error: String(error?.message || error) });
    }
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`[bridge] 监听 http://127.0.0.1:${PORT}`);
    console.log(`[bridge] 转发到 ${GRADIO}（ASR 端点 /${ASR_API}）`);
    checkGradio().then((g) => {
        console.log(g.ok ? `[bridge] Gradio 在线，共 ${g.endpoints} 个端点` : `[bridge] Gradio 没连上：${g.error}`);
    });
});
