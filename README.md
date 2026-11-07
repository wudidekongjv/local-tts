# local-tts —— 无限画布的本地语音节点

把本机跑的 **Breeze-TTS WebUI**（`127.0.0.1:9000`）接进无限画布：在画布里拖一个节点，选一段音频，点转写，文字直接落成画布里的文本节点。

全程在本机完成，不联网、不上传云端。

---

## 一、这套东西由三部分组成

| 组成 | 作用 | 端口 |
| --- | --- | --- |
| Breeze-TTS WebUI | 真正的 ASR / TTS 模型 | `127.0.0.1:9000` |
| 本地桥 `bridge/breeze_bridge.mjs` | 给画布一个允许跨域的简单接口 | `127.0.0.1:9001` |
| 画布节点插件 `dist/local-asr.js` | 画布里那个「本地转写」节点 | — |

**为什么中间要有一个桥？** 两条实测结论：

1. Gradio 的接口预检能过，但响应里**不带** `Access-Control-Allow-Origin`，从画布（https 页面）直接 fetch 会被浏览器按 CORS 拦掉。
2. Gradio 一次调用是三段式：先 `POST /gradio_api/upload` 上传音频拿临时路径，再 `POST /gradio_api/call/auto_transcribe` 换 `event_id`，最后 `GET .../<event_id>` 读 SSE。放进节点里拼容易碎。

桥把这两件事挡在外面：节点只跟桥说话，桥再按正确姿势调 Gradio。

---

## 二、启动（每次两条）

**第 1 条：Breeze WebUI**（在项目目录里）

```bat
cd /d F:\SD\breeze-tts-260916
.\build_venv\python.exe -u webui.py .\breeze-tts-2 --asr-model-dir ./asr_models --server-name 127.0.0.1 --server-port 9000
```

**第 2 条：本地桥**（双击仓库里的 `启动桥.bat`，或者手动）

```bat
node bridge\breeze_bridge.mjs
```

看到这两行就说明成了：

```
[bridge] 监听 http://127.0.0.1:9001
[bridge] Gradio 在线，共 155 个端点
```

浏览器打开 <http://127.0.0.1:9001/health>，应该返回：

```json
{"ok":true,"bridge":true,"port":9001,"gradio":{"ok":true,"endpoints":155,"asr":true,...},"asrApi":"auto_transcribe"}
```

`"gradio":{"ok":false...}` 表示桥活着但连不上 WebUI —— 先确认第 1 条那个窗口没报错。

---

## 三、装进画布

画布 → 设置 → 节点插件 → 第三方 → 粘贴这一条：

```
https://cdn.jsdelivr.net/gh/wudidekongjv/local-tts@main/dist/local-asr.js
```

装好后左侧节点列表里多一个 **「本地转写」**（🎙）。

---

## 四、怎么用

1. 拖一个「本地转写」节点
2. 点「测试连接」，出现「桥正常 · WebUI 在线（155 个接口）」就通了
3. 给音频：点「选本地文件」，**或**在左边连一个音频节点
4. 点「开始转写」
5. 出字以后点「落成文本节点」，右边会自动长出一个文本节点并连线

节点里的桥地址默认 `http://127.0.0.1:9001`，一般不用改。

---

## 五、会遇到的限制（都不是 bug）

| 现象 | 原因 |
| --- | --- |
| 上游音频节点连了却没反应 | 画布素材库是 `https://canvas-assets`（DenyCors），页面 fetch 不到。**用「选本地文件」**，或者上游节点的 content 是 `data:` / `blob:` |
| 第一次转写特别久 | 模型要加载，几十秒到几分钟。之后同一段音频只要几百毫秒 |
| 提示「没识别出文字」 | 接口通了，但音频里没有人声（纯音乐、正弦波都会这样）。换一段真人说话的音频 |
| 文件超过 30MB 被拒 | 音频是以 base64 塞进 JSON 传的，太大不划算。剪一段再转 |
| 转写结果只有一行 | Breeze 的 `/auto_transcribe` 只返回一段纯文本，不做分段、不给时间戳，也出不了 SRT |

---

## 六、仓库里都是什么

```
bridge/breeze_bridge.mjs   本地桥：CORS、上传、三段式调用、SSE 解析
src/index.js               插件源码（手写 React.createElement，不用 JSX）
build.mjs                  esbuild → dist/local-asr.js 单文件
dist/local-asr.js          画布实际加载的那一个文件
test/smoke.mjs             结构自检（不连服务就能跑）
test/live.mjs              真实链路测试（需要桥在跑）
启动桥.bat                 双击起桥
```

开发：

```bat
npm install
node build.mjs
node test\smoke.mjs
```

---

## 七、排错

**画布上报「连桥失败」**

- 先看 `http://127.0.0.1:9001/health` 在浏览器里有没有返回 JSON。打不开就是桥没起。
- 桥在跑、但 `/health` 里 `gradio.ok=false`：第 1 条那个 WebUI 窗口挂了或者端口被改。

**画布上报「Failed to fetch」且桥明明是活的**

- 说明请求根本没发出去，多半是页面和桥之间的跨域/混合内容被拦。先确认画布页面确实能连本机（换台机器测一下 `curl http://127.0.0.1:9001/health`）。
- 桥地址写成 `http://127.0.0.1:9001`，不要写 `localhost` 之外的域名，也不要加 https。

**TTS 那半边**

桥里已经写好了 `/tts`（对应 Gradio 的 `do_voice_design` / `do_voice_clone` / `do_voice_direction`），但画布节点目前只做了转写。要加朗读节点时说一声。
