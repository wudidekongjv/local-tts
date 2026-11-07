// 真实链路测试：画布节点 → 桥 → Gradio。需要桥和 WebUI 都在跑。
//
//   $env:SF_TEST_WAV='C:\path\to\audio.wav'; node test/live.mjs
import fs from "node:fs";

const BRIDGE = process.env.BRIDGE_URL || "http://127.0.0.1:9001";
const WAV = process.env.SF_TEST_WAV || "";

if (!WAV) {
    console.log("跳过：需要 SF_TEST_WAV 指向一段音频");
    process.exit(0);
}

const health = await (await fetch(BRIDGE + "/health")).json();
console.log("health →", JSON.stringify(health));
if (!health?.ok || !health?.gradio?.ok) {
    console.error("桥或 WebUI 没就绪");
    process.exit(1);
}

const base64 = fs.readFileSync(WAV).toString("base64");
const started = Date.now();
const response = await fetch(BRIDGE + "/asr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audioBase64: base64, filename: "test.wav", mime: "audio/wav" }),
});
const body = await response.json();
console.log(`asr → HTTP ${response.status}, ${Date.now() - started}ms`);
console.log(JSON.stringify(body).slice(0, 300));

process.exit(body?.ok ? 0 : 1);
