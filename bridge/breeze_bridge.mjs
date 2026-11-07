// Breeze-TTS 本地桥：把本地 Gradio 服务包装成「允许跨域」的简单接口给无限画布用。
//
// 为什么需要它（这三条都是实测结论，不是猜的）：
// 1. Gradio 的 /gradio_api/call/* 预检通过了，但响应里不带 Access-Control-Allow-Origin，
//    所以从 https 的画布页面直接 fetch 会被浏览器按 CORS 拦掉。
// 2. Gradio 的真实调用是三段式：先 /gradio_api/upload 上传文件拿到临时路径，
//    再 POST /gradio_api/call/<api> 换 event_id，最后 GET .../<event_id> 读 SSE。
//    这一步画布页面自己拼很容易出错，放在桥里做一次就够了。
// 3. 桥自己会回 Access-Control-Allow-Origin（还能回 Private-Network 头），
//    所以画布页面只要连桥就行，不用碰 Gradio。
//
// 用法：node bridge/breeze_bridge.mjs
// 环境变量：BREEZE_BASE（默认 http://127.0.0.1:9000）、BRIDGE_PORT（默认 9001）

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
    let lastError = null;
    for (const line of raw.split(/\r?\n/)) {
        const s = line.trim();
        if (s.startsWith("event:")) {
            const name = s.slice(6).trim();
            armed = name === "complete";
            if (name === "error") lastError = true;
            continue;
        }
        if (armed && s.startsWith("data:")) {
            payload = s.slice(5).trim();
            armed = false;
        }
    }
    if (payload === null) return { ok: false, error: lastError ? "Gradio 返回 error 事件" : "没有收到 complete 事件" };
    try {
        return { ok: true, data: JSON.parse(payload) };
    } catch {
        return { ok: false, error: "complete 的 data 不是 JSON：" + payload.slice(0, 160) };
    }
}

/** 上传一个 Blob 到 Gradio，拿回服务端临时路径 */
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

/** 三段式调用一个 Gradio 端点，返回 complete 的 data 数组 */
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
    if (!parsed.ok) {
        // 有时 Gradio 会在 data 里塞 {"error": ...}
        const m = /"error"\s*:\s*["{]?([^"}]*)/.exec(raw);
        throw new Error(parsed.error + (m ? `（${m[1]}）` : ""));
    }
    return { data: parsed.data, ms: Date.now() - started };
}

function toFileData(path, filename) {
    return { path, orig_name: filename, meta: { _type: "gradio.FileData" } };
}

/** 从 Gradio 返回的 Audio 值里取出音频字节 */
async function audioToBuffer(value) {
    if (!value) throw new Error("Gradio 没有返回音频");
    let path = "";
    if (typeof value === "string") path = value;
    else if (typeof value === "object") path = value.path || value.name || "";
    if (!path) throw new Error("返回结构里找不到音频路径：" + JSON.stringify(value).slice(0, 200));

    try {
        const buf = await fs.readFile(path);
        return { buffer: buf, path };
    } catch {
        // 路径读不到就退回 url 下载
        const url = typeof value === "object" ? value.url : "";
        if (!url) throw new Error("音频文件读不到，也没有可下载的 url");
        const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`下载音频 HTTP ${response.status}`);
        return { buffer: Buffer.from(await response.arrayBuffer()), path };
    }
}

async function handleAsr(payload) {
    const { audioBase64, filename, mime } = payload || {};
    if (!audioBase64) throw new Error("缺少 audioBase64");
    const raw = Buffer.from(String(audioBase64), "base64");
    if (!raw.length) throw new Error("音频解码后是空的");
    const name = String(filename || "audio.wav").replace(/[\\/:*?"<>|]/g, "_");
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
    const cfgScale = Number(body.cfgScale ?? 4);
    const speed = Number(body.speed ?? 1);
    const seed = Number(body.seed ?? 42);

    let data;
    if (mode === "clone") {
        if (!body.refAudioBase64) throw new Error("克隆模式需要 refAudioBase64");
        const raw = Buffer.from(String(body.refAudioBase64), "base64");
        const name = String(body.refFilename || "ref.wav").replace(/[\\/:*?"<>|]/g, "_");
        const remotePath = await uploadToGradio(new Blob([raw], { type: body.refMime || "audio/wav" }), name);
        data = [text, toFileData(remotePath, name), String(body.refText || ""), cfgScale, speed, seed];
        const result = await callGradio("do_voice_clone", data);
        return finishTts(result);
    }
    if (mode === "direction") {
        if (!body.refAudioBase64) throw new Error("情绪模式需要参考音频");
        const raw = Buffer.from(String(body.refAudioBase64), "base64");
        const name = String(body.refFilename || "ref.wav").replace(/[\\/:*?"<>|]/g, "_");
        const remotePath = await uploadToGradio(new Blob([raw], { type: body.refMime || "audio/wav" }), name);
        const dual = Boolean(body.useDual);
        data = [
            text,
            toFileData(remotePath, name),
            String(body.refText || ""),
            String(body.instruction || ""),
            cfgScale,
            speed,
            seed,
            dual,
            Number(body.cfgRef ?? 4),
            Number(body.cfgIns ?? 4),
        ];
        const result = await callGradio("do_voice_direction", data);
        return finishTts(result);
    }
    // 默认：音色设计（只给文字 + 音色描述，不需要参考音频）
    data = [text, String(body.instruction || ""), cfgScale, speed, seed];
    const result = await callGradio("do_voice_design", data);
    return finishTts(result);
}

async function finishTts(result) {
    const values = Array.isArray(result.data) ? result.data : [];
    const audio = await audioToBuffer(values[0]);
    const note = typeof values[1] === "string" ? values[1] : "";
    return {
        audioBase64: audio.buffer.toString("base64"),
        mime: /\.mp3$/i.test(audio.path) ? "audio/mpeg" : "audio/wav",
        bytes: audio.buffer.length,
        ms: result.ms,
        note,
    };
}

async function checkGradio() {
    try {
        const response = await fetch(`${GRADIO}/gradio_api/info`, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
        const info = await response.json();
        const endpoints = Object.keys(info.named_endpoints || {});
        const hasAsr = endpoints.some((n) => n.includes(ASR_API));
        return { ok: true, endpoints: endpoints.length, asr: hasAsr, base: GRADIO };
    } catch (error) {
        return { ok: false, error: String(error?.message || error), base: GRADIO };
    }
}

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
        if (req.method === "POST" && (route === "/asr" || route === "/tts")) {
            const raw = await readBody(req);
            let payload = {};
            try {
                payload = JSON.parse(raw.toString("utf8") || "{}");
            } catch {
                json(res, 400, { ok: false, error: "请求体不是合法 JSON" });
                return;
            }
            const result = route === "/asr" ? await handleAsr(payload) : await handleTts(payload);
            json(res, 200, { ok: true, ...result });
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
