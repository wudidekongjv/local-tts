# local-tts —— 无限画布的本地语音节点

把本机跑的 **Breeze-TTS WebUI**（`127.0.0.1:9000`）接进无限画布。WebUI 上那六个页签——模型配置、音色克隆、音色设计、音色情绪控制、多角色配音、SRT 字幕配音——在画布里各是一个节点，加一个语音转文字，一共七个。

全程在本机完成，不联网、不上传云端。

---

## 一、这套东西由三部分组成

| 组成 | 作用 | 端口 |
| --- | --- | --- |
| Breeze-TTS WebUI | 真正的 ASR / TTS 模型 | `127.0.0.1:9000` |
| 本地桥 `bridge/breeze_bridge.mjs` | 给画布一个允许跨域的简单接口 | `127.0.0.1:9001` |
| 画布节点插件 `dist/local-asr.js` | 画布里那七个节点 | — |

**为什么中间要有一个桥？** 三条实测结论：

1. Gradio 的接口预检能过，但响应里**不带** `Access-Control-Allow-Origin`，从画布（https 虚拟域）直接 fetch 会被浏览器按 CORS 拦掉。
2. Gradio 一次调用是三段式：先 `POST /gradio_api/upload` 上传文件拿临时路径（表单字段名必须是 `files`），再 `POST /gradio_api/call/<api>` 换 `event_id`，最后 `GET .../<event_id>` 读 SSE，取 `event: complete` 之后那行 `data:`。
3. 每个页签的参数顺序都不一样，放进节点里拼容易碎。

桥把这三件事挡在外面：节点只跟桥说话，桥再按正确姿势调 Gradio。

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

改过桥的源码必须**重启桥进程**才生效（双击启动的那次不算重载）。

---

## 三、装进画布

画布 → 设置 → 节点插件 → 第三方 → 粘贴这一条：

```
https://cdn.jsdelivr.net/gh/wudidekongjv/local-tts@main/dist/local-asr.js
```

文件名还叫 `local-asr.js`（为了链接不变），内容已经是整包。

装好后左侧节点列表里会多出七个节点。**如果之前装过只有转写的那一版（插件 id 是 `local-asr`），先卸掉再装**，两者不能并存。

---

## 四、七个节点怎么用

所有节点的第一个动作都是点「测试连接」，出现「桥正常 · WebUI 在线（155 个接口）」再往下走。桥地址默认 `http://127.0.0.1:9001`。

| 节点 | 对应 WebUI 页签 | 给什么 | 出什么 |
| --- | --- | --- | --- |
| ⚙ 语音服务配置 | 模型配置 | 桥地址、offload 开关 | 连通性 + 音色库清单 |
| 🎙 语音转文字 | （ASR） | 音频文件或上游音频节点 | 文本，可落成文本节点 |
| 🎨 音色设计 | 音色设计 | 文本 + 音色描述（如「年轻女性，语气自然」） | 造出一个声音念你的文字 |
| 🎙 音色克隆 | 音色克隆 | 参考音频 + 参考文本 + 目标文本 | 用参考音色念目标文本 |
| 🎛 音色情绪控制 | 音色情绪控制 | 参考音色 + 参考文本 + 表达指令（如「压低声音，颤抖地」） | 带情绪的同音色配音 |
| 👥 多角色配音 | 多角色配音 | 脚本（`[张三]: 台词` 一行一句）+ 每个角色的音色与语速 | 一段多角色对白 |
| 🎬 SRT 字幕配音 | SRT 字幕配音 | 一个 `.srt` + 音色 | 按时间轴整段配音 |

**参考音频的三种给法**（克隆 / 情绪两个节点）：

1. 点「选参考音频」——最稳，本地文件直接读；
2. 在左边连一个音频节点——它的内容必须是 `data:` 或 `blob:`；
3. 「从音色库载入」——下拉里列的是 WebUI `voices/` 目录里的音色，选中会顺带把参考文本填好。

**多角色配音的脚本格式**：角色靠行首 `[角色名]:` 识别，`[笑]` 这种方括号是情绪提示，不会当成角色。最多 8 个角色，多的截掉。

**出音频之后**：

- 节点里可以直接播放；
- 点「落成音频节点」，右侧长出一个音频节点并连线（依赖画布的 `nodeType: "audio"`，见下面限制）；
- 点「下载」拿 wav 到本机。

---

## 五、会遇到的限制（都不是 bug）

| 现象 | 原因 |
| --- | --- |
| 生成特别慢 | 这台机实测 RTF≈36：1.52 秒音频跑了 54 秒。**1 秒音频要 30 秒左右**，长句请耐心等，别重复点 |
| 桥报 600 秒超时 | 已把 TTS 分支的超时提到 30 分钟；如果仍然超时，说明 WebUI 那边卡住了，去看它的窗口 |
| 上游音频节点连了却没反应 | 画布素材库是 `https://canvas-assets`（DenyCors），页面 fetch 不到。**用「选本地文件」** |
| 音色下拉只有一项 | `voices/` 目录里目前只有一个示例音色。要更多就去 WebUI 的音色克隆页签里存 |
| 音频落成节点后刷新不见了 | 音频是以 base64 data URL 存进节点元数据的，几十 KB 到几 MB。体积大时优先点「下载」 |
| 多角色只有 8 组 | Gradio 那边就是固定 8 组（8 个角色名 + 8 个音色 + 8 个语速），超出的角色会被截掉 |
| 转写结果只有一行 | `/auto_transcribe` 只返回一段纯文本，不分段、不给时间戳 |
| 文件超过 30MB 被拒 | 文件是以 base64 塞进 JSON 传的 |

**一个还没实测的点**：画布页面是 `https://hushifu.local`，桥是 `http://127.0.0.1:9001`，属于混合内容。桥已经回了 `Access-Control-Allow-Private-Network: true`，但真机上有没有被拦，取决于画布宿主自己怎么放行——这一段至今没在真机上验过（本机画布 profile 一直被占用，起不来）。如果节点里点「测试连接」直接报 `Failed to fetch`，就是这个原因，告诉我，桥要改成 https。

---

## 六、仓库里都是什么

```
bridge/breeze_bridge.mjs   本地桥：CORS、上传、三段式调用、SSE 解析、七条路由
src/index.js               插件源码（手写 React.createElement，不用 JSX）
build.mjs                  esbuild → dist/local-asr.js 单文件
dist/local-asr.js          画布实际加载的那一个文件
test/smoke.mjs             结构自检（不连服务就能跑，11 项）
test/live.mjs              真实链路测试（需要桥在跑）
启动桥.bat                 双击起桥
```

桥的路由：

```
GET  /health          桥 + WebUI 状态
GET  /voices          音色库清单
GET  /voice?name=     取某个音色的参考音频 + 参考文本
POST /asr             转写
POST /tts             mode=design|clone|direction
POST /multi           多角色
POST /srt             SRT 配音
POST /offload         低显存模式开关
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

- 请求根本没发出去，多半是混合内容被拦（见上面那条未实测项）。
- 桥地址写成 `http://127.0.0.1:9001`，别写域名，别加 https。

**生成报 `{"error": null}` 之类看不出原因的错**

- 那是 Gradio 的 SSE 只回了 `event: error`。多半是文件没先 upload 就当成 FileData 传了，或者上传时表单字段名写成了 `file`。桥里已经按 `files` 处理，自己改代码时注意别动。

**生成了但没声音 / 很短**

- 文本太短（一个词）时，模型容易输出近乎空白的音频。写一句完整的话试。
