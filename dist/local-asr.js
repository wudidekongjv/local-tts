// src/index.js
var DEFAULT_BRIDGE = "http://127.0.0.1:9001";
var VOICE_PLACEHOLDER = "---\u4E0B\u62C9\u9009\u62E9\u97F3\u8272---";
var MAX_BYTES = 30 * 1024 * 1024;
var SLOW_HINT = "Breeze \u5728\u8FD9\u53F0\u673A\u4E0A\u5F88\u6162\uFF08\u7EA6 30 \u500D\u5B9E\u65F6\uFF09\uFF0C1 \u79D2\u97F3\u9891\u8981 30 \u79D2\u5DE6\u53F3\uFF0C\u957F\u53E5\u8BF7\u8010\u5FC3\u7B49";
function randomId(prefix) {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}-${crypto.randomUUID()}`;
    }
  } catch {
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
function isAudioNode(node2) {
  if (!node2) return false;
  const mime = String(node2?.metadata?.mimeType || "").toLowerCase();
  if (mime.startsWith("audio/")) return true;
  const type = String(node2?.type || "");
  if (type === "audio" || type.endsWith(":audio")) return true;
  const content = String(node2?.metadata?.content || "");
  return /^data:audio\//i.test(content) || /\.(mp3|wav|m4a|aac|ogg|flac|webm)(\?|#|$)/i.test(content);
}
function findUpstreamAudio(ctx) {
  let list = [];
  try {
    list = ctx.getUpstream?.() || [];
  } catch {
    list = [];
  }
  for (const node2 of list) {
    if (node2?.id === ctx.node?.id) continue;
    if (!isAudioNode(node2)) continue;
    const content = node2?.metadata?.content;
    if (typeof content === "string" && content.trim()) {
      return { node: node2, content: content.trim() };
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
    throw new Error("\u8FD9\u4E2A\u97F3\u9891\u662F\u753B\u5E03\u7D20\u6750\u5E93\u5730\u5740\uFF08canvas-assets \u7981\u6B62\u8DE8\u57DF\uFF09\uFF0C\u9875\u9762\u6293\u4E0D\u5230\u3002\u8BF7\u70B9\u300C\u9009\u672C\u5730\u6587\u4EF6\u300D\u91CD\u65B0\u4E0A\u4F20\u4E00\u6B21\u3002");
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
function bridgeBase(url) {
  const base = String(url || DEFAULT_BRIDGE).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error("\u6865\u5730\u5740\u8981\u4EE5 http:// \u5F00\u5934\uFF0C\u4F8B\u5982 http://127.0.0.1:9001");
  return base;
}
async function getJson(url) {
  const response = await fetch(url, { method: "GET", cache: "no-store" });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`\u8FD4\u56DE\u7684\u4E0D\u662F JSON\uFF08HTTP ${response.status}\uFF09\uFF1A` + text.slice(0, 140));
  }
  return parsed;
}
async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`\u8FD4\u56DE\u7684\u4E0D\u662F JSON\uFF08HTTP ${response.status}\uFF09\uFF1A` + text.slice(0, 140));
  }
  if (!parsed?.ok) throw new Error(parsed?.error || `HTTP ${response.status}`);
  return parsed;
}
var API = {
  health: (bridge) => getJson(bridgeBase(bridge) + "/health"),
  voices: (bridge) => getJson(bridgeBase(bridge) + "/voices"),
  voice: (bridge, name) => getJson(bridgeBase(bridge) + "/voice?name=" + encodeURIComponent(name)),
  asr: (bridge, payload) => postJson(bridgeBase(bridge) + "/asr", payload),
  tts: (bridge, payload) => postJson(bridgeBase(bridge) + "/tts", payload),
  multi: (bridge, payload) => postJson(bridgeBase(bridge) + "/multi", payload),
  srt: (bridge, payload) => postJson(bridgeBase(bridge) + "/srt", payload)
};
var MODES = {
  design: {
    title: "\u{1F3A8} \u97F3\u8272\u8BBE\u8BA1",
    desc: "\u53EA\u7ED9\u6587\u5B57 + \u97F3\u8272\u63CF\u8FF0\uFF0C\u51ED\u7A7A\u9020\u4E00\u4E2A\u58F0\u97F3",
    cfg: 4,
    needInstruction: true
  },
  clone: {
    title: "\u{1F399} \u97F3\u8272\u514B\u9686",
    desc: "\u7ED9\u4E00\u6BB5\u53C2\u8003\u97F3\u9891\uFF0C\u7528\u5B83\u7684\u97F3\u8272\u5FF5\u4F60\u7684\u6587\u5B57",
    cfg: 1,
    needRef: true
  },
  direction: {
    title: "\u{1F39B} \u97F3\u8272\u60C5\u7EEA\u63A7\u5236",
    desc: "\u53C2\u8003\u97F3\u8272 + \u8868\u8FBE\u6307\u4EE4\uFF08\u5982\u300C\u538B\u4F4E\u58F0\u97F3\uFF0C\u98A4\u6296\u5730\u300D\uFF09\uFF0C\u590D\u523B\u8BED\u6C14",
    cfg: 4,
    needRef: true,
    needInstruction: true
  },
  multi: {
    title: "\u{1F465} \u591A\u89D2\u8272\u914D\u97F3",
    desc: "\u811A\u672C\u5199\u6210 [\u89D2\u8272]: \u53F0\u8BCD \u7684\u5F62\u5F0F\uFF0C\u4E00\u6B21\u51FA\u591A\u89D2\u8272\u5BF9\u767D",
    isMulti: true
  },
  srt: {
    title: "\u{1F3AC} SRT \u5B57\u5E55\u914D\u97F3",
    desc: "\u4E0A\u4F20 .srt\uFF0C\u6309\u5B57\u5E55\u65F6\u95F4\u8F74\u6574\u6BB5\u914D\u97F3",
    isSrt: true
  },
  asr: { title: "\u{1F399} \u8BED\u97F3\u8F6C\u6587\u5B57" }
};
function styles(ctx) {
  const node2 = ctx?.theme?.node || {};
  return {
    field: {
      width: "100%",
      boxSizing: "border-box",
      border: `1px solid ${node2.stroke || "#ffffff33"}`,
      borderRadius: 8,
      padding: "6px 8px",
      background: "transparent",
      color: node2.text || "#eee",
      fontSize: 12,
      outline: "none"
    },
    area: {
      width: "100%",
      boxSizing: "border-box",
      border: `1px solid ${node2.stroke || "#ffffff33"}`,
      borderRadius: 8,
      padding: "6px 8px",
      background: "transparent",
      color: node2.text || "#eee",
      fontSize: 12,
      outline: "none",
      minHeight: 70,
      resize: "vertical",
      fontFamily: "inherit",
      lineHeight: 1.6
    },
    label: { color: node2.muted || "#999", fontSize: 11, marginBottom: 2 },
    button: {
      border: `1px solid ${node2.stroke || "#ffffff33"}`,
      borderRadius: 8,
      padding: "7px 10px",
      background: "transparent",
      color: node2.text || "#eee",
      fontSize: 12,
      cursor: "pointer",
      width: "100%"
    },
    hint: { color: node2.muted || "#999", fontSize: 11, lineHeight: 1.6 },
    row: { display: "flex", gap: 6, alignItems: "center" },
    card: {
      border: `1px solid ${node2.stroke || "#ffffff33"}`,
      borderRadius: 8,
      padding: "8px 10px",
      fontSize: 12,
      lineHeight: 1.7,
      maxHeight: 180,
      overflow: "auto",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word"
    }
  };
}
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
  const signature = JSON.stringify({
    bridgeUrl,
    text,
    instruction,
    cfgScale,
    speed,
    seed,
    refText,
    voiceName,
    script,
    roleConfig,
    mode
  });
  React.useEffect(() => {
    const m = ctxRef.current.node?.metadata || {};
    if (m.__sig === signature) return;
    ctxRef.current.updateMetadata?.({
      __sig: signature,
      bridgeUrl,
      text,
      instruction,
      cfgScale,
      speed,
      seed,
      refText,
      voiceName,
      script,
      roleConfig
    });
  }, [signature]);
  React.useEffect(() => {
    if (mode !== "srt" && mode !== "clone" && mode !== "multi") return;
    if (Array.isArray(voicePool) && voicePool.length) return;
    API.voices(bridgeUrl).then((r) => {
      if (Array.isArray(r?.voices)) setVoicePool(r.voices);
    }).catch(() => null);
  }, []);
  const upstreamAudio = findUpstreamAudio(ctx);
  const roles = parseRoles(script);
  function getRole(name) {
    const item = roleConfig?.[name] || {};
    return { voice: item.voice || VOICE_PLACEHOLDER, speed: Number(item.speed ?? 1) };
  }
  function setRole(name, patch) {
    setRoleConfig((prev) => ({ ...prev || {}, [name]: { ...getRole(name), ...patch } }));
  }
  async function testBridge() {
    if (busy) return;
    setBusy(true);
    setStatus("\u6B63\u5728\u8FDE\u6865\u2026");
    try {
      const health = await API.health(bridgeUrl);
      if (!health?.ok) throw new Error(health?.error || "\u6865\u6CA1\u5C31\u7EEA");
      if (!health?.gradio?.ok) throw new Error("\u6865\u6D3B\u7740\uFF0C\u4F46\u8FDE\u4E0D\u4E0A Breeze WebUI\uFF1A" + (health?.gradio?.error || "\u672A\u77E5"));
      setStatus(`\u6865\u6B63\u5E38 \xB7 WebUI \u5728\u7EBF\uFF08${health.gradio.endpoints} \u4E2A\u63A5\u53E3\uFF09`);
    } catch (error) {
      setStatus("\u8FDE\u6865\u5931\u8D25\uFF1A" + String(error?.message || error));
    } finally {
      setBusy(false);
    }
  }
  async function refreshVoices() {
    try {
      const r = await API.voices(bridgeUrl);
      setVoicePool(Array.isArray(r?.voices) ? r.voices : []);
      setStatus(r?.voices?.length ? `\u97F3\u8272\u5E93 ${r.voices.length} \u4E2A` : "\u97F3\u8272\u5E93\u662F\u7A7A\u7684\uFF0C\u5148\u53BB WebUI \u91CC\u5B58\u4E00\u4E2A");
    } catch (error) {
      setStatus("\u8BFB\u97F3\u8272\u5E93\u5931\u8D25\uFF1A" + String(error?.message || error));
    }
  }
  async function pickVoice(name) {
    setVoiceName(name);
    setLoadedVoice(null);
    if (!name || name === VOICE_PLACEHOLDER) return;
    setStatus("\u6B63\u5728\u8F7D\u5165\u97F3\u8272 " + name + "\u2026");
    try {
      const r = await API.voice(bridgeUrl, name);
      setLoadedVoice({ base64: r.audioBase64, mime: r.mime, name });
      if (!refText && r.text) setRefText(r.text);
      setStatus(`\u5DF2\u8F7D\u5165\u97F3\u8272\uFF1A${name}`);
    } catch (error) {
      setStatus("\u8F7D\u5165\u97F3\u8272\u5931\u8D25\uFF1A" + String(error?.message || error));
    }
  }
  async function resolveRef() {
    if (refFile) {
      if (refFile.size > MAX_BYTES) throw new Error(`\u53C2\u8003\u97F3\u9891 ${(refFile.size / 1048576).toFixed(1)}MB \u592A\u5927`);
      return { base64: await blobToBase64(refFile), name: refFile.name || "ref.wav", mime: refFile.type || "audio/wav" };
    }
    if (upstreamAudio) {
      const got = await contentToBlob(upstreamAudio.content, "ref.wav");
      return { base64: await blobToBase64(got.blob), name: got.name || "ref.wav", mime: got.blob.type || "audio/wav" };
    }
    if (loadedVoice?.base64) {
      return { base64: loadedVoice.base64, name: loadedVoice.name || "ref.wav", mime: loadedVoice.mime || "audio/wav" };
    }
    throw new Error("\u7F3A\u53C2\u8003\u97F3\u9891\uFF1A\u70B9\u300C\u9009\u53C2\u8003\u97F3\u9891\u300D\u3001\u5728\u5DE6\u8FB9\u8FDE\u4E00\u4E2A\u97F3\u9891\u8282\u70B9\uFF0C\u6216\u5148\u4ECE\u97F3\u8272\u5E93\u8F7D\u5165\u4E00\u4E2A");
  }
  async function generate() {
    if (busy) return;
    setBusy(true);
    setStatus("\u6B63\u5728\u63D0\u4EA4\u2026");
    try {
      let payload = null;
      let runner = null;
      if (cfgInfo.isMulti) {
        if (!String(script || "").trim()) throw new Error("\u5148\u5199\u914D\u97F3\u811A\u672C");
        if (!roles.length) throw new Error("\u811A\u672C\u91CC\u6CA1\u6709\u89D2\u8272\uFF0C\u8981\u5199\u6210 [\u5F20\u4E09]: \u53F0\u8BCD \u7684\u5F62\u5F0F");
        const names = Array.from({ length: 8 }, (_, i) => roles[i] || "");
        const voices = roles.map((n) => getRole(n).voice).concat(Array(Math.max(0, 8 - roles.length)).fill(VOICE_PLACEHOLDER)).slice(0, 8);
        const speeds = roles.map((n) => getRole(n).speed).concat(Array(Math.max(0, 8 - roles.length)).fill(1)).slice(0, 8);
        payload = { script, seed, roles: names, voices, speeds };
        runner = () => API.multi(bridgeUrl, payload);
      } else if (cfgInfo.isSrt) {
        if (!srtFile) throw new Error("\u5148\u9009\u4E00\u4E2A .srt \u6587\u4EF6");
        payload = {
          srtBase64: await blobToBase64(srtFile),
          srtName: srtFile.name || "subtitle.srt",
          voice: voiceName || VOICE_PLACEHOLDER,
          seed
        };
        runner = () => API.srt(bridgeUrl, payload);
      } else {
        payload = {
          mode,
          text,
          instruction,
          cfgScale,
          speed,
          seed
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
      setStatus("\u751F\u6210\u4E2D\u2026" + SLOW_HINT);
      const result = await runner();
      if (!result?.audioBase64) throw new Error("\u6865\u6CA1\u6709\u8FD4\u56DE\u97F3\u9891");
      const dataUrl = `data:${result.mime || "audio/wav"};base64,${result.audioBase64}`;
      const kb = Math.round((result.bytes || 0) / 1024);
      setAudioUrl(dataUrl);
      setAudioMime(result.mime || "audio/wav");
      setNote(result.note || "");
      setStatus(`\u5B8C\u6210 \xB7 ${kb}KB \xB7 \u751F\u6210\u8017\u65F6 ${((result.ms || 0) / 1e3).toFixed(1)} \u79D2`);
      ctxRef.current.updateMetadata?.({
        audioDataUrl: dataUrl,
        audioMime: result.mime || "audio/wav",
        note: result.note || "",
        lastStatus: "\u4E0A\u6B21\u751F\u6210\u5B8C\u6210"
      });
    } catch (error) {
      setStatus(String(error?.message || error));
    } finally {
      setBusy(false);
    }
  }
  function addAudioNode() {
    const node2 = ctxRef.current.node;
    if (!audioUrl) {
      setStatus("\u8FD8\u6CA1\u6709\u97F3\u9891");
      return;
    }
    const id = randomId("local-tts-audio");
    const x = (node2?.position?.x ?? 0) + (node2?.width ?? 380) + 96;
    const y = node2?.position?.y ?? 0;
    const title = `${cfgInfo.title.replace(/^[^\u4e00-\u9fa5A-Za-z]+/, "")} \xB7 ${String(text || script || "\u914D\u97F3").slice(0, 24) || "\u914D\u97F3"}`;
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
            mimeType: audioMime || "audio/wav"
          }
        },
        { type: "connect_nodes", fromNodeId: node2?.id, toNodeId: id }
      ]);
      setStatus("\u5DF2\u843D\u6210\u97F3\u9891\u8282\u70B9");
    } catch (error) {
      setStatus("\u5EFA\u97F3\u9891\u8282\u70B9\u5931\u8D25\uFF1A" + String(error?.message || error));
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
      setStatus("\u5DF2\u5F00\u59CB\u4E0B\u8F7D");
    } catch (error) {
      setStatus("\u4E0B\u8F7D\u5931\u8D25\uFF1A" + String(error?.message || error));
    }
  }
  const rows = [
    h("div", { style: { fontSize: 15, fontWeight: 600 } }, cfgInfo.title),
    h("div", { style: s.hint }, cfgInfo.desc),
    h("div", null, [
      h("div", { style: s.label }, "\u672C\u5730\u6865\u5730\u5740"),
      h("input", {
        style: s.field,
        type: "text",
        spellCheck: false,
        value: bridgeUrl,
        onMouseDown: stop,
        onChange: (e) => setBridgeUrl(e.target.value.trim())
      }),
      h(
        "button",
        { type: "button", style: { ...s.button, marginTop: 4 }, disabled: busy, onMouseDown: stop, onClick: testBridge },
        "\u6D4B\u8BD5\u8FDE\u63A5"
      )
    ])
  ];
  if (cfgInfo.isMulti) {
    rows.push(h("div", null, [
      h("div", { style: s.label }, "\u914D\u97F3\u811A\u672C\uFF08\u6BCF\u884C [\u89D2\u8272]: \u53F0\u8BCD\uFF09"),
      h("textarea", {
        style: s.area,
        value: script,
        onMouseDown: stop,
        onChange: (e) => setScript(e.target.value)
      }),
      h("div", { style: s.hint }, roles.length ? `\u8BC6\u522B\u5230 ${roles.length} \u4E2A\u89D2\u8272\uFF1A${roles.join("\u3001")}` : "\u8FD8\u6CA1\u6709\u89D2\u8272\uFF0C\u6309 [\u5F20\u4E09]: \u4F60\u597D \u7684\u683C\u5F0F\u5199")
    ]));
    if (roles.length) {
      rows.push(h("div", null, [
        h("div", { style: { ...s.label, marginTop: 4 } }, "\u89D2\u8272\u97F3\u8272"),
        ...roles.map((name) => h("div", { key: name, style: { ...s.row, marginTop: 4 } }, [
          h("div", { style: { ...s.hint, width: 64, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, name),
          h("select", {
            style: { ...s.field, flex: 1 },
            value: getRole(name).voice,
            onMouseDown: stop,
            onChange: (e) => setRole(name, { voice: e.target.value })
          }, [
            h("option", { key: "none", value: VOICE_PLACEHOLDER }, VOICE_PLACEHOLDER),
            ...voicePool.map((v) => h("option", { key: v, value: v }, v))
          ]),
          h("input", {
            type: "number",
            step: "0.1",
            style: { ...s.field, width: 60, flex: "none" },
            value: getRole(name).speed,
            onMouseDown: stop,
            onChange: (e) => setRole(name, { speed: Number(e.target.value) })
          })
        ]))
      ]));
    }
  } else if (cfgInfo.isSrt) {
    rows.push(h("div", null, [
      h("div", { style: s.label }, "\u5B57\u5E55\u6587\u4EF6"),
      h("input", {
        ref: srtRef,
        type: "file",
        accept: ".srt,text/plain",
        style: { display: "none" },
        onChange: (e) => {
          setSrtFile(e.target.files?.[0] || null);
          setStatus("");
        }
      }),
      h(
        "button",
        { type: "button", style: { ...s.button, marginTop: 2 }, onMouseDown: stop, onClick: () => srtRef.current?.click() },
        srtFile ? `\u6362\u4E00\u4E2A\uFF08${srtFile.name}\uFF09` : "\u9009 .srt \u6587\u4EF6"
      )
    ]));
    rows.push(h("div", null, [
      h("div", { style: { ...s.label, marginTop: 4 } }, "\u97F3\u8272"),
      h("select", {
        style: s.field,
        value: voiceName || VOICE_PLACEHOLDER,
        onMouseDown: stop,
        onChange: (e) => setVoiceName(e.target.value)
      }, [
        h("option", { key: "none", value: VOICE_PLACEHOLDER }, VOICE_PLACEHOLDER),
        ...voicePool.map((v) => h("option", { key: v, value: v }, v))
      ]),
      h("button", { type: "button", style: { ...s.button, marginTop: 4 }, onMouseDown: stop, onClick: refreshVoices }, "\u5237\u65B0\u97F3\u8272\u5E93")
    ]));
  } else {
    rows.push(h("div", null, [
      h("div", { style: s.label }, "\u76EE\u6807\u6587\u672C"),
      h("textarea", {
        style: s.area,
        value: text,
        placeholder: "\u8981\u5FF5\u7684\u5185\u5BB9",
        onMouseDown: stop,
        onChange: (e) => setText(e.target.value)
      })
    ]));
    if (cfgInfo.needInstruction) {
      rows.push(h("div", null, [
        h("div", { style: s.label }, mode === "direction" ? "\u8868\u8FBE / \u60C5\u7EEA\u6307\u4EE4" : "\u97F3\u8272\u63CF\u8FF0"),
        h("input", {
          style: s.field,
          type: "text",
          value: instruction,
          placeholder: mode === "direction" ? "\u4F8B\u5982\uFF1A\u538B\u4F4E\u58F0\u97F3\uFF0C\u5E26\u7740\u98A4\u6296" : "\u4F8B\u5982\uFF1A\u5E74\u8F7B\u5973\u6027\uFF0C\u8BED\u6C14\u81EA\u7136",
          onMouseDown: stop,
          onChange: (e) => setInstruction(e.target.value)
        })
      ]));
    }
    if (cfgInfo.needRef) {
      const refSource = refFile ? `\u672C\u5730\u6587\u4EF6\uFF1A${refFile.name}` : upstreamAudio ? `\u4E0A\u6E38\u8282\u70B9\uFF1A${upstreamAudio.node.title || upstreamAudio.node.id}` : loadedVoice ? `\u97F3\u8272\u5E93\uFF1A${loadedVoice.name}` : "\u8FD8\u6CA1\u6709\u53C2\u8003\u97F3\u9891";
      rows.push(h("div", null, [
        h("div", { style: s.label }, "\u53C2\u8003\u97F3\u9891"),
        h("div", { style: { ...s.hint, marginBottom: 4 } }, refSource),
        h("input", {
          ref: fileRef,
          type: "file",
          accept: "audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac",
          style: { display: "none" },
          onChange: (e) => {
            setRefFile(e.target.files?.[0] || null);
            setLoadedVoice(null);
            setStatus("");
          }
        }),
        h("div", { style: s.row }, [
          h(
            "button",
            { type: "button", style: { ...s.button, flex: 1 }, onMouseDown: stop, onClick: () => fileRef.current?.click() },
            refFile ? "\u6362\u6587\u4EF6" : "\u9009\u53C2\u8003\u97F3\u9891"
          ),
          h(
            "button",
            { type: "button", style: { ...s.button, flex: 1 }, onMouseDown: stop, onClick: () => {
              setRefFile(null);
              setLoadedVoice(null);
              setVoiceName("");
            } },
            "\u6E05\u7A7A"
          )
        ]),
        h("div", { style: { ...s.label, marginTop: 6 } }, "\u6216\u8005\u4ECE\u97F3\u8272\u5E93\u8F7D\u5165"),
        h("select", {
          style: s.field,
          value: voiceName || VOICE_PLACEHOLDER,
          onMouseDown: stop,
          onChange: (e) => pickVoice(e.target.value)
        }, [
          h("option", { key: "none", value: VOICE_PLACEHOLDER }, VOICE_PLACEHOLDER),
          ...voicePool.map((v) => h("option", { key: v, value: v }, v))
        ]),
        h("button", { type: "button", style: { ...s.button, marginTop: 4 }, onMouseDown: stop, onClick: refreshVoices }, "\u5237\u65B0\u97F3\u8272\u5E93"),
        h("div", { style: { ...s.label, marginTop: 6 } }, "\u53C2\u8003\u97F3\u9891\u5BF9\u5E94\u7684\u6587\u5B57"),
        h("input", {
          style: s.field,
          type: "text",
          value: refText,
          placeholder: "\u53C2\u8003\u97F3\u9891\u91CC\u8BF4\u4E86\u4EC0\u4E48\uFF08\u77ED\u53E5\uFF0C10 \u79D2\u4EE5\u5185\uFF09",
          onMouseDown: stop,
          onChange: (e) => setRefText(e.target.value)
        })
      ]));
    }
    rows.push(h("div", null, [
      h("div", { style: s.row }, [
        h("div", { style: { flex: 1 } }, [
          h("div", { style: s.label }, "CFG"),
          h("input", { type: "number", step: "0.1", style: s.field, value: cfgScale, onMouseDown: stop, onChange: (e) => setCfgScale(Number(e.target.value)) })
        ]),
        h("div", { style: { flex: 1 } }, [
          h("div", { style: s.label }, "\u8BED\u901F"),
          h("input", { type: "number", step: "0.1", style: s.field, value: speed, onMouseDown: stop, onChange: (e) => setSpeed(Number(e.target.value)) })
        ]),
        h("div", { style: { flex: 1 } }, [
          h("div", { style: s.label }, "\u79CD\u5B50"),
          h("input", { type: "number", step: "1", style: s.field, value: seed, onMouseDown: stop, onChange: (e) => setSeed(Number(e.target.value)) })
        ])
      ])
    ]));
  }
  rows.push(h("button", {
    type: "button",
    style: { ...s.button, marginTop: 4, fontWeight: 600 },
    disabled: busy,
    onMouseDown: stop,
    onClick: generate
  }, busy ? "\u751F\u6210\u4E2D\u2026" : "\u5F00\u59CB\u751F\u6210"));
  if (status) {
    rows.push(h("div", {
      style: {
        fontSize: 11,
        lineHeight: 1.5,
        color: busy ? "#ffd54f" : /失败|缺|先|没有/.test(status) ? "#ef9a9a" : "#9ccc65",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word"
      }
    }, status));
  }
  if (audioUrl) {
    rows.push(h("audio", { src: audioUrl, controls: true, style: { width: "100%", marginTop: 2 } }));
    if (note) rows.push(h("div", { style: s.hint }, note));
    rows.push(h("div", { style: { ...s.row, marginTop: 4 } }, [
      h("button", { type: "button", style: { ...s.button, flex: 1 }, onMouseDown: stop, onClick: addAudioNode }, "\u843D\u6210\u97F3\u9891\u8282\u70B9"),
      h("button", { type: "button", style: { ...s.button, flex: 1 }, onMouseDown: stop, onClick: downloadAudio }, "\u4E0B\u8F7D")
    ]));
    const sizeMB = audioUrl.length / 1048576;
    if (sizeMB > 2) {
      rows.push(h("div", { style: s.hint }, `\u97F3\u9891\u6570\u636E\u7EA6 ${sizeMB.toFixed(1)}MB\uFF0C\u5B58\u8FDB\u753B\u5E03\u53EF\u80FD\u5403\u7D27\uFF0C\u5EFA\u8BAE\u5148\u4E0B\u8F7D`));
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
      color: ctx.theme.node.text
    }
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
    setStatus("\u6B63\u5728\u8FDE\u6865\u2026");
    try {
      const health = await API.health(bridgeUrl);
      if (!health?.gradio?.ok) throw new Error("\u8FDE\u4E0D\u4E0A WebUI\uFF1A" + (health?.gradio?.error || "\u672A\u77E5"));
      let voices = [];
      try {
        voices = (await API.voices(bridgeUrl))?.voices || [];
      } catch {
        voices = [];
      }
      setStatus(`WebUI \u5728\u7EBF \xB7 ${health.gradio.endpoints} \u4E2A\u63A5\u53E3 \xB7 \u97F3\u8272 ${voices.length} \u4E2A${voices.length ? "\uFF1A" + voices.join("\u3001") : ""}`);
    } catch (error) {
      setStatus("\u5931\u8D25\uFF1A" + String(error?.message || error));
    }
  }
  async function toggleOffload(value) {
    setOffload(value);
    setStatus(value ? "\u5DF2\u52FE\u9009 offload\uFF08\u5BF9\u4E4B\u540E\u6240\u6709\u9875\u7B7E\u751F\u6548\uFF09" : "\u5DF2\u53D6\u6D88 offload");
    try {
      await postJson(bridgeBase(bridgeUrl) + "/offload", { enabled: value });
    } catch {
    }
  }
  return h("div", {
    style: {
      display: "flex",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      gap: 8,
      padding: 12,
      boxSizing: "border-box",
      overflow: "auto",
      color: ctx.theme.node.text
    }
  }, [
    h("div", { style: { fontSize: 15, fontWeight: 600 } }, "\u2699 \u6A21\u578B\u914D\u7F6E"),
    h("div", { style: s.hint }, "\u8FD9\u91CC\u53EA\u914D\u5B83\u4E0E\u672C\u5730\u670D\u52A1\u600E\u4E48\u8FDE\uFF1B\u58F0\u97F3\u53C2\u6570\u5728\u5404\u8BED\u97F3\u8282\u70B9\u7684\u9762\u677F\u91CC"),
    h("div", null, [
      h("div", { style: s.label }, "\u672C\u5730\u6865\u5730\u5740"),
      h("input", { style: s.field, type: "text", value: bridgeUrl, onMouseDown: stop, onChange: (e) => setBridgeUrl(e.target.value.trim()) }),
      h("button", { type: "button", style: { ...s.button, marginTop: 4 }, onMouseDown: stop, onClick: check }, "\u6D4B\u8BD5\u8FDE\u63A5")
    ]),
    h("label", { style: { ...s.row, cursor: "pointer", marginTop: 2 } }, [
      h("input", { type: "checkbox", checked: offload, onChange: (e) => toggleOffload(e.target.checked) }),
      h("span", { style: s.hint }, "\u542F\u7528 offload \u4F4E\u663E\u5B58\u6A21\u5F0F\uFF08\u538B\u4F4E\u751F\u6210\u5CF0\u503C\u663E\u5B58\uFF09")
    ]),
    status ? h("div", { style: { fontSize: 11, lineHeight: 1.6, color: /失败/.test(status) ? "#ef9a9a" : "#9ccc65", whiteSpace: "pre-wrap" } }, status) : null,
    h(
      "div",
      { style: s.hint },
      "\u8D77\u670D\u52A1\uFF1A\u5148\u8DD1 Breeze \u7684 webui.py\uFF089000\uFF09\uFF0C\u518D\u53CC\u51FB\u4ED3\u5E93\u91CC\u7684\u300C\u542F\u52A8\u6865.bat\u300D\uFF089001\uFF09\u3002"
    )
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
    setStatus("\u6B63\u5728\u8FDE\u6865\u2026");
    try {
      const health = await API.health(bridgeUrl);
      if (!health?.gradio?.ok) throw new Error("\u8FDE\u4E0D\u4E0A WebUI\uFF1A" + (health?.gradio?.error || "\u672A\u77E5"));
      setStatus(`\u6865\u6B63\u5E38 \xB7 WebUI \u5728\u7EBF\uFF08${health.gradio.endpoints} \u4E2A\u63A5\u53E3\uFF09`);
    } catch (error) {
      setStatus("\u8FDE\u6865\u5931\u8D25\uFF1A" + String(error?.message || error));
    } finally {
      setBusy(false);
    }
  }
  async function resolveAudio() {
    if (picked) {
      if (picked.size > MAX_BYTES) throw new Error(`\u6587\u4EF6 ${(picked.size / 1048576).toFixed(1)}MB \u8D85\u8FC7\u4E0A\u9650`);
      return { base64: await blobToBase64(picked), name: picked.name || "audio.wav", mime: picked.type || "audio/wav" };
    }
    if (!upstreamAudio) throw new Error("\u6CA1\u6709\u97F3\u9891\uFF1A\u5148\u5728\u5DE6\u8FB9\u8FDE\u4E00\u4E2A\u97F3\u9891\u8282\u70B9\uFF0C\u6216\u70B9\u300C\u9009\u672C\u5730\u6587\u4EF6\u300D");
    const title = `${upstreamAudio.node.title || "audio"}`.replace(/[\\/:*?"<>|]/g, "_");
    const wantName = /\.[a-z0-9]{2,5}$/i.test(title) ? title : `${title}.mp3`;
    const got = await contentToBlob(upstreamAudio.content, wantName);
    return { base64: await blobToBase64(got.blob), name: wantName, mime: got.blob.type || "audio/mpeg" };
  }
  async function run() {
    if (busy) return;
    setBusy(true);
    setStatus("\u6B63\u5728\u8F6C\u5199\u2026");
    try {
      const audio = await resolveAudio();
      const r = await API.asr(bridgeUrl, { audioBase64: audio.base64, filename: audio.name, mime: audio.mime });
      const text = String(r.text || "").trim();
      setResult(text);
      setMs(r.ms ?? null);
      setStatus(text ? `\u5B8C\u6210 \xB7 \u8017\u65F6 ${r.ms ?? "?"}ms` : "\u63A5\u53E3\u901A\u4E86\uFF0C\u4F46\u6CA1\u8BC6\u522B\u51FA\u6587\u5B57\uFF08\u97F3\u9891\u91CC\u53EF\u80FD\u6CA1\u6709\u4EBA\u58F0\uFF09");
      ctxRef.current.updateMetadata?.({ result: text, ms: r.ms ?? null, fileName: audio.name, lastStatus: "\u4E0A\u6B21\u8F6C\u5199\u5B8C\u6210" });
    } catch (error) {
      setStatus(String(error?.message || error));
    } finally {
      setBusy(false);
    }
  }
  function addTextNode() {
    const node2 = ctxRef.current.node;
    const text = String(result || "").trim();
    if (!text) {
      setStatus("\u8FD8\u6CA1\u6709\u8F6C\u5199\u7ED3\u679C");
      return;
    }
    const id = randomId("local-tts-text");
    const x = (node2?.position?.x ?? 0) + (node2?.width ?? 380) + 96;
    const y = node2?.position?.y ?? 0;
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
        { type: "connect_nodes", fromNodeId: node2?.id, toNodeId: id }
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
      color: ctx.theme.node.text
    }
  }, [
    h("div", { style: { fontSize: 15, fontWeight: 600 } }, MODES.asr.title + " \xB7 \u672C\u5730 Breeze"),
    h("div", { style: s.hint }, "\u8D70\u672C\u673A Breeze WebUI\uFF08127.0.0.1:9000\uFF09\uFF0C\u4E0D\u8054\u7F51"),
    h("div", null, [
      h("div", { style: s.label }, "\u672C\u5730\u6865\u5730\u5740"),
      h("input", { style: s.field, type: "text", value: bridgeUrl, onMouseDown: stop, onChange: (e) => setBridgeUrl(e.target.value.trim()) }),
      h("button", { type: "button", style: { ...s.button, marginTop: 4 }, disabled: busy, onMouseDown: stop, onClick: testBridge }, "\u6D4B\u8BD5\u8FDE\u63A5")
    ]),
    h("div", null, [
      h("div", { style: s.label }, "\u97F3\u9891"),
      h(
        "div",
        { style: { ...s.hint, marginBottom: 4 } },
        picked ? `\u672C\u5730\u6587\u4EF6\uFF1A${picked.name}\uFF08${(picked.size / 1048576).toFixed(2)}MB\uFF09` : upstreamAudio ? `\u4E0A\u6E38\u8282\u70B9\uFF1A${upstreamAudio.node.title || upstreamAudio.node.id}` : "\u672A\u8FDE\u63A5\u97F3\u9891\u8282\u70B9"
      ),
      h("input", {
        ref: fileRef,
        type: "file",
        accept: "audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm",
        style: { display: "none" },
        onChange: (e) => {
          setPicked(e.target.files?.[0] || null);
          setStatus("");
        }
      }),
      h(
        "button",
        { type: "button", style: { ...s.button, marginTop: 2 }, onMouseDown: stop, onClick: () => fileRef.current?.click() },
        picked ? "\u6362\u4E00\u4E2A\u6587\u4EF6" : "\u9009\u672C\u5730\u6587\u4EF6"
      ),
      picked ? h("button", {
        type: "button",
        style: { ...s.button, marginTop: 4, borderColor: "#ffffff22" },
        onMouseDown: stop,
        onClick: () => {
          setPicked(null);
          if (fileRef.current) fileRef.current.value = "";
        }
      }, "\u6539\u7528\u4E0A\u6E38\u8282\u70B9") : null
    ]),
    h(
      "button",
      { type: "button", style: { ...s.button, marginTop: 4, fontWeight: 600 }, disabled: busy, onMouseDown: stop, onClick: run },
      busy ? "\u8F6C\u5199\u4E2D\u2026" : "\u5F00\u59CB\u8F6C\u5199"
    ),
    status ? h("div", {
      style: { fontSize: 11, lineHeight: 1.5, color: busy ? "#ffd54f" : /失败|没识别|先|没有/.test(status) ? "#ef9a9a" : "#9ccc65", whiteSpace: "pre-wrap", wordBreak: "break-word" }
    }, status) : null,
    result ? h("div", null, [
      h("div", { style: s.label }, "\u8F6C\u5199\u7ED3\u679C"),
      h("div", { style: s.card }, result),
      h("div", { style: { ...s.row, marginTop: 6 } }, [
        h("button", { type: "button", style: { ...s.button, flex: 1 }, onMouseDown: stop, onClick: addTextNode }, "\u843D\u6210\u6587\u672C\u8282\u70B9"),
        h("button", { type: "button", style: { ...s.button, flex: 1 }, onMouseDown: stop, onClick: copyResult }, "\u590D\u5236")
      ])
    ]) : null,
    ms ? h("div", { style: s.hint }, `\u4E0A\u6B21\u8017\u65F6\uFF1A${ms}ms`) : null
  ]);
}
function node(mode, extra) {
  const info = MODES[mode];
  return {
    type: `local-tts:${mode}`,
    title: info.title,
    icon: Array.from(info.title)[0] || "\u{1F3B5}",
    description: info.desc,
    defaultSize: { width: 380, height: mode === "multi" ? 620 : mode === "srt" ? 460 : 520 },
    defaultMetadata: Object.assign({ bridgeUrl: DEFAULT_BRIDGE, mode }, extra || {}),
    hasSourceHandle: true,
    hidePanel: true
  };
}
function createLocalTtsPlugin(runtime) {
  const React = runtime.React;
  return {
    id: "local-tts",
    name: "\u672C\u5730\u8BED\u97F3\uFF08Breeze-TTS\uFF09",
    version: "0.2.0",
    minAppVersion: "0.12.0",
    description: "\u628A\u672C\u673A Breeze-TTS WebUI \u63A5\u8FDB\u753B\u5E03\uFF1A\u8F6C\u5199\u3001\u514B\u9686\u3001\u8BBE\u8BA1\u3001\u60C5\u7EEA\u3001\u591A\u89D2\u8272\u3001SRT\u3002",
    nodes: [
      {
        type: "local-tts:settings",
        title: "\u8BED\u97F3\u670D\u52A1\u914D\u7F6E",
        icon: "\u2699",
        description: "\u6865\u5730\u5740\u3001\u8FDE\u901A\u6027\u3001\u4F4E\u663E\u5B58\u5F00\u5173",
        defaultSize: { width: 380, height: 320 },
        defaultMetadata: { bridgeUrl: DEFAULT_BRIDGE, offload: false },
        hasSourceHandle: false,
        hidePanel: true,
        Content: (props) => SettingsContent({ ...props, React })
      },
      {
        type: "local-tts:asr",
        title: MODES.asr.title,
        icon: "\u{1F399}",
        description: "\u97F3\u9891 \u2192 \u6587\u5B57\uFF0C\u7ED3\u679C\u843D\u6210\u6587\u672C\u8282\u70B9",
        defaultSize: { width: 380, height: 500 },
        defaultMetadata: { bridgeUrl: DEFAULT_BRIDGE, result: "" },
        hasSourceHandle: true,
        hidePanel: true,
        Content: (props) => AsrContent({ ...props, React })
      },
      ...["clone", "design", "direction", "multi", "srt"].map((mode) => ({
        ...node(mode),
        Content: (props) => TtsContent({ ...props, React, mode })
      }))
    ]
  };
}
export {
  createLocalTtsPlugin as default
};
