// src/index.js
var DEFAULT_BRIDGE = "http://127.0.0.1:9001";
var MAX_BYTES = 30 * 1024 * 1024;
function randomId(prefix) {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}-${crypto.randomUUID()}`;
    }
  } catch {
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
    response = await fetch(content, isHttp ? { mode: "cors", credentials: "omit" } : void 0);
  } catch {
    throw new Error("\u8FD9\u4E2A\u97F3\u9891\u662F\u753B\u5E03\u7D20\u6750\u5E93\u5730\u5740\uFF08canvas-assets \u7981\u6B62\u8DE8\u57DF\uFF09\uFF0C\u9875\u9762\u6293\u4E0D\u5230\u3002\u8BF7\u70B9\u4E0B\u9762\u7684\u300C\u9009\u672C\u5730\u6587\u4EF6\u300D\u91CD\u65B0\u4E0A\u4F20\u4E00\u6B21\u3002");
  }
  if (!response.ok) throw new Error(`\u8BFB\u53D6\u97F3\u9891\u5931\u8D25\uFF1AHTTP ${response.status}`);
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
    reader.onerror = () => reject(new Error("\u8BFB\u53D6\u6587\u4EF6\u5931\u8D25"));
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
    throw new Error("\u6865\u8FD4\u56DE\u7684\u4E0D\u662F JSON\uFF1A" + body.slice(0, 120));
  }
  if (!json?.ok) throw new Error(json?.error || "\u6865\u6CA1\u5C31\u7EEA");
  if (!json?.gradio?.ok) throw new Error("\u6865\u6D3B\u7740\uFF0C\u4F46\u8FDE\u4E0D\u4E0A Breeze WebUI\uFF1A" + (json?.gradio?.error || "\u672A\u77E5"));
  return json;
}
async function callBridgeAsr({ bridgeUrl, base64, filename, mime }) {
  const base = String(bridgeUrl || DEFAULT_BRIDGE).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error("\u6865\u5730\u5740\u8981\u4EE5 http:// \u5F00\u5934\uFF0C\u4F8B\u5982 http://127.0.0.1:9001");
  const response = await fetch(base + "/asr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audioBase64: base64, filename, mime })
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`\u6865\u8FD4\u56DE\u4E86\u975E JSON\uFF08HTTP ${response.status}\uFF09\uFF1A` + text.slice(0, 140));
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
      outline: "none"
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
      width: "100%"
    }
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
        throw new Error(`\u6587\u4EF6 ${(picked.size / 1048576).toFixed(1)}MB\uFF0C\u8D85\u8FC7 ${MAX_BYTES / 1048576}MB \u4E0A\u9650`);
      }
      const base642 = await blobToBase64(picked);
      return { base64: base642, name: picked.name || "audio.wav", mime: picked.type || "audio/wav" };
    }
    if (!upstreamAudio) throw new Error("\u6CA1\u6709\u97F3\u9891\uFF1A\u5148\u5728\u5DE6\u8FB9\u8FDE\u4E00\u4E2A\u97F3\u9891\u8282\u70B9\uFF0C\u6216\u70B9\u300C\u9009\u672C\u5730\u6587\u4EF6\u300D");
    const title = `${upstreamAudio.node.title || "audio"}`.replace(/[\\/:*?"<>|]/g, "_");
    const wantName = /\.[a-z0-9]{2,5}$/i.test(title) ? title : `${title}.mp3`;
    const got = await contentToBlob(upstreamAudio.content, wantName);
    const base64 = await blobToBase64(got.blob);
    return { base64, name: wantName, mime: got.blob.type || "audio/mpeg" };
  }
  async function testBridge() {
    if (busy) return;
    setBusy(true);
    setStatus("\u6B63\u5728\u8FDE\u6865\u2026");
    try {
      const health = await pingBridge(bridgeUrl);
      setStatus(`\u6865\u6B63\u5E38 \xB7 WebUI \u5728\u7EBF\uFF08${health.gradio.endpoints} \u4E2A\u63A5\u53E3\uFF09`);
    } catch (error) {
      setStatus("\u8FDE\u6865\u5931\u8D25\uFF1A" + String(error?.message || error));
    } finally {
      setBusy(false);
    }
  }
  async function run() {
    if (busy) return;
    setBusy(true);
    setStatus("\u6B63\u5728\u8F6C\u5199\u2026\uFF08\u9996\u6B21\u52A0\u8F7D\u6A21\u578B\u4F1A\u6162\u4E00\u4E9B\uFF09");
    try {
      const audio = await resolveAudio();
      const r = await callBridgeAsr({
        bridgeUrl,
        base64: audio.base64,
        filename: audio.name,
        mime: audio.mime
      });
      const text = String(r.text || "").trim();
      setResult(text);
      setMs(r.ms ?? null);
      setStatus(text ? `\u5B8C\u6210 \xB7 \u8017\u65F6 ${r.ms ?? "?"}ms` : "\u63A5\u53E3\u901A\u4E86\uFF0C\u4F46\u6CA1\u8BC6\u522B\u51FA\u6587\u5B57\uFF08\u97F3\u9891\u91CC\u53EF\u80FD\u6CA1\u6709\u4EBA\u58F0\uFF09");
      ctxRef.current.updateMetadata?.({
        result: text,
        ms: r.ms ?? null,
        fileName: audio.name,
        lastStatus: "\u4E0A\u6B21\u8F6C\u5199\u5B8C\u6210"
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
      setStatus("\u8FD8\u6CA1\u6709\u8F6C\u5199\u7ED3\u679C");
      return;
    }
    const id = randomId("local-asr-text");
    const x = (node?.position?.x ?? 0) + (node?.width ?? 380) + 96;
    const y = node?.position?.y ?? 0;
    const title = `\u8F6C\u5199 \xB7 ${String(meta.fileName || "\u97F3\u9891").slice(0, 40)}`;
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
          metadata: { content: text, status: "success" }
        },
        { type: "connect_nodes", fromNodeId: node?.id, toNodeId: id }
      ]);
      setStatus("\u5DF2\u843D\u6210\u6587\u672C\u8282\u70B9");
    } catch (error) {
      setStatus("\u5EFA\u6587\u672C\u8282\u70B9\u5931\u8D25\uFF1A" + String(error?.message || error));
    }
  }
  async function copyResult() {
    try {
      await navigator.clipboard.writeText(String(result || ""));
      setStatus("\u5DF2\u590D\u5236");
    } catch {
      setStatus("\u590D\u5236\u5931\u8D25\uFF0C\u624B\u52A8\u9009\u4E2D\u5427");
    }
  }
  return h(
    "div",
    {
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
        color: ctx.theme.node.text
      }
    },
    h("div", { style: { fontSize: 15, fontWeight: 600 } }, "\u{1F399} \u8BED\u97F3\u8F6C\u6587\u5B57 \xB7 \u672C\u5730 Breeze"),
    h(
      "div",
      { style: { color: ctx.theme.node.muted, fontSize: 11, lineHeight: 1.6 } },
      "\u8D70\u672C\u673A Breeze WebUI\uFF08127.0.0.1:9000\uFF09\uFF0C\u4E0D\u8054\u7F51\u3001\u4E0D\u4F20\u4E91\u7AEF"
    ),
    h(
      "div",
      null,
      h("div", { style: s.label }, "\u672C\u5730\u6865\u5730\u5740"),
      h("input", {
        style: s.field,
        type: "text",
        spellCheck: false,
        placeholder: DEFAULT_BRIDGE,
        value: bridgeUrl,
        onMouseDown: stop,
        onChange: (event) => setBridgeUrl(event.target.value.trim())
      })
    ),
    h("button", {
      type: "button",
      style: { ...s.button, marginTop: 2 },
      disabled: busy,
      onMouseDown: stop,
      onClick: testBridge
    }, "\u6D4B\u8BD5\u8FDE\u63A5"),
    h(
      "div",
      { style: { marginTop: 4 } },
      h("div", { style: s.label }, "\u97F3\u9891"),
      h(
        "div",
        { style: { color: ctx.theme.node.muted, fontSize: 11, marginBottom: 4 } },
        picked ? `\u672C\u5730\u6587\u4EF6\uFF1A${picked.name}\uFF08${(picked.size / 1048576).toFixed(2)}MB\uFF09` : upstreamAudio ? `\u4E0A\u6E38\u8282\u70B9\uFF1A${upstreamAudio.node.title || upstreamAudio.node.id}` : "\u672A\u8FDE\u63A5\u97F3\u9891\u8282\u70B9"
      ),
      h("input", {
        ref: fileRef,
        type: "file",
        accept: "audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm",
        style: { display: "none" },
        onChange: (event) => {
          const f = event.target.files?.[0] || null;
          setPicked(f);
          setStatus("");
        }
      }),
      h("button", {
        type: "button",
        style: { ...s.button, marginTop: 2 },
        onMouseDown: stop,
        onClick: () => fileRef.current?.click()
      }, picked ? "\u6362\u4E00\u4E2A\u6587\u4EF6" : "\u9009\u672C\u5730\u6587\u4EF6"),
      picked ? h("button", {
        type: "button",
        style: { ...s.button, marginTop: 4, borderColor: "#ffffff22" },
        onMouseDown: stop,
        onClick: () => {
          setPicked(null);
          if (fileRef.current) fileRef.current.value = "";
        }
      }, "\u6539\u7528\u4E0A\u6E38\u8282\u70B9") : null
    ),
    h("button", {
      type: "button",
      style: { ...s.button, marginTop: 4, fontWeight: 600 },
      disabled: busy,
      onMouseDown: stop,
      onClick: run
    }, busy ? "\u8F6C\u5199\u4E2D\u2026" : "\u5F00\u59CB\u8F6C\u5199"),
    status ? h("div", {
      style: {
        fontSize: 11,
        lineHeight: 1.5,
        color: busy ? "#ffd54f" : /失败|没识别|不能|先在/.test(status) ? "#ef9a9a" : "#9ccc65",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word"
      }
    }, status) : null,
    result ? h(
      "div",
      null,
      h("div", { style: s.label }, "\u8F6C\u5199\u7ED3\u679C"),
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
          wordBreak: "break-word"
        }
      }, result),
      h(
        "div",
        { style: { display: "flex", gap: 6, marginTop: 6 } },
        h("button", {
          type: "button",
          style: { ...s.button, flex: 1 },
          onMouseDown: stop,
          onClick: addTextNode
        }, "\u843D\u6210\u6587\u672C\u8282\u70B9"),
        h("button", {
          type: "button",
          style: { ...s.button, flex: 1 },
          onMouseDown: stop,
          onClick: copyResult
        }, "\u590D\u5236")
      )
    ) : null,
    ms ? h("div", { style: { fontSize: 11, color: ctx.theme.node.muted } }, `\u4E0A\u6B21\u8017\u65F6\uFF1A${ms}ms`) : null
  );
}
function createLocalTtsPlugin(runtime) {
  const React = runtime.React;
  return {
    id: "local-asr",
    name: "\u672C\u5730\u8BED\u97F3\u8F6C\u6587\u5B57\uFF08Breeze\uFF09",
    version: "0.1.0",
    minAppVersion: "0.12.0",
    description: "\u628A\u97F3\u9891\u4EA4\u7ED9\u672C\u673A Breeze-TTS WebUI \u8F6C\u5199\uFF0C\u7ED3\u679C\u843D\u6210\u6587\u672C\u8282\u70B9\u3002",
    nodes: [
      {
        type: "local-asr:transcribe",
        title: "\u672C\u5730\u8F6C\u5199",
        icon: "\u{1F399}",
        description: "\u672C\u5730\u6865 \u2192 Breeze WebUI \u2192 \u6587\u672C\u8282\u70B9",
        defaultSize: { width: 380, height: 500 },
        defaultMetadata: {
          bridgeUrl: DEFAULT_BRIDGE,
          result: ""
        },
        hasSourceHandle: true,
        hidePanel: true,
        Content: (props) => AsrContent({ ...props, React })
      }
    ]
  };
}
export {
  createLocalTtsPlugin as default
};
