// 结构自检：不连服务、不开浏览器，只验证插件出厂形态正确。
import createPlugin from "../dist/local-asr.js";

function makeFakeReact() {
    return {
        createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
        useState: (v) => [v, () => {}],
        useEffect: () => {},
        useRef: (v) => ({ current: v }),
        useMemo: (fn) => fn(),
        useCallback: (fn) => fn,
    };
}

const checks = [];
function check(name, fn) {
    try {
        fn();
        checks.push([name, true, ""]);
    } catch (error) {
        checks.push([name, false, String(error?.message || error)]);
    }
}

const plugin = createPlugin({ React: makeFakeReact() });
const nodes = plugin.nodes || [];

check("插件 id 是 local-tts", () => {
    if (plugin.id !== "local-tts") throw new Error("id=" + plugin.id);
});
check("有 name/version/minAppVersion/description", () => {
    for (const k of ["name", "version", "minAppVersion", "description"]) {
        if (!plugin[k]) throw new Error("缺 " + k);
    }
});
check("六个页签都在（配置 + 转写 + 5 个语音）", () => {
    const want = ["settings", "asr", "clone", "design", "direction", "multi", "srt"];
    const got = nodes.map((n) => n.type.split(":")[1]);
    for (const w of want) {
        if (!got.includes(w)) throw new Error("缺节点：" + w + "（现有 " + got.join(",") + "）");
    }
    if (nodes.length !== want.length) throw new Error("节点数 " + nodes.length + " 应为 " + want.length);
});
check("节点类型都带 local-tts: 前缀", () => {
    for (const n of nodes) {
        if (!/^local-tts:/.test(n.type)) throw new Error("type=" + n.type);
    }
});
check("每个节点有 title/icon/description", () => {
    for (const n of nodes) {
        if (!n.title || !n.icon || !n.description) throw new Error("节点 " + n.type + " 缺字段");
    }
});
check("defaultSize 都是数字", () => {
    for (const n of nodes) {
        const s = n.defaultSize || {};
        if (typeof s.width !== "number" || typeof s.height !== "number") throw new Error(n.type + " defaultSize 不完整");
    }
});
check("defaultMetadata 都指向 9001 桥", () => {
    for (const n of nodes) {
        const m = n.defaultMetadata || {};
        if (!/^http:\/\/127\.0\.0\.1:9001/.test(m.bridgeUrl)) throw new Error(n.type + " bridgeUrl=" + m.bridgeUrl);
    }
});
check("出厂不带密钥", () => {
    for (const n of nodes) {
        const dump = JSON.stringify(n.defaultMetadata || {});
        if (/sk-|apiKey/i.test(dump)) throw new Error(n.type + " 默认元数据里有疑似密钥");
    }
});
check("每个节点 Content 是函数且能渲染", () => {
    for (const n of nodes) {
        if (typeof n.Content !== "function") throw new Error(n.type + " Content 不是函数");
        const ctx = {
            node: {
                id: "n1", title: "测试节点", width: 380, height: 520,
                position: { x: 0, y: 0 },
                metadata: { ...(n.defaultMetadata || {}) },
            },
            theme: { node: { text: "#eee", muted: "#999", stroke: "#ffffff33" } },
            getUpstream: () => [],
            updateMetadata: () => {},
            applyOps: () => {},
        };
        const tree = n.Content({ ctx });
        if (!tree || typeof tree !== "object") throw new Error(n.type + " Content 没返回元素");
    }
});
check("只有配置节点没有出线", () => {
    for (const n of nodes) {
        if (n.type === "local-tts:settings" && n.hasSourceHandle !== false) throw new Error("配置节点不该 hasSourceHandle");
        if (n.type !== "local-tts:settings" && n.hasSourceHandle !== true) throw new Error(n.type + " 应 hasSourceHandle");
    }
});
check("面板文案没有 undefined/NaN", () => {
    for (const n of nodes) {
        if (/undefined|NaN/.test(`${n.title}${n.description}`)) throw new Error(n.type + " 文案里有 undefined/NaN");
    }
});

let failed = 0;
for (const [name, ok, message] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  → " + message}`);
    if (!ok) failed += 1;
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
