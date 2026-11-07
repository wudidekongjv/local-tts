// 结构自检：不连服务、不开浏览器，只验证插件出厂形态正确。
import createPlugin from "../dist/local-asr.js";

const checks = [];
function check(name, fn) {
    try {
        fn();
        checks.push([name, true, ""]);
    } catch (error) {
        checks.push([name, false, String(error?.message || error)]);
    }
}

const runtime = { React: makeFakeReact() };

function makeFakeReact() {
    const createElement = (type, props, ...children) => ({ type, props: props || {}, children });
    const hooks = [];
    return {
        createElement,
        useState: (v) => [v, () => {}],
        useEffect: () => {},
        useRef: (v) => ({ current: v }),
        useMemo: (fn) => fn(),
        __hooks: hooks,
    };
}

const plugin = createPlugin(runtime);

check("插件 id", () => {
    if (plugin.id !== "local-asr") throw new Error("id 不对：" + plugin.id);
});
check("有 name/version/minAppVersion", () => {
    for (const k of ["name", "version", "minAppVersion", "description"]) {
        if (!plugin[k]) throw new Error("缺 " + k);
    }
});
check("nodes 是数组且非空", () => {
    if (!Array.isArray(plugin.nodes) || plugin.nodes.length === 0) throw new Error("nodes 空");
});
check("节点类型带命名空间", () => {
    if (!/^local-asr:/.test(plugin.nodes[0].type)) throw new Error("type=" + plugin.nodes[0].type);
});
check("节点有 title/icon", () => {
    const n = plugin.nodes[0];
    if (!n.title || !n.icon) throw new Error("缺 title/icon");
});
check("defaultSize 数值完整", () => {
    const s = plugin.nodes[0].defaultSize || {};
    if (typeof s.width !== "number" || typeof s.height !== "number") throw new Error("defaultSize 不完整");
});
check("hasSourceHandle 为 true", () => {
    if (plugin.nodes[0].hasSourceHandle !== true) throw new Error("hasSourceHandle 应为 true");
});
check("Content 是函数", () => {
    if (typeof plugin.nodes[0].Content !== "function") throw new Error("Content 不是函数");
});
check("defaultMetadata 有 bridgeUrl", () => {
    const m = plugin.nodes[0].defaultMetadata || {};
    if (!/^http:\/\/127\.0\.0\.1:9001/.test(m.bridgeUrl)) throw new Error("bridgeUrl=" + m.bridgeUrl);
});
check("出厂不带密钥", () => {
    const dump = JSON.stringify(plugin.nodes[0].defaultMetadata || {});
    if (/sk-|apiKey/i.test(dump)) throw new Error("默认元数据里有疑似密钥");
});
check("Content 渲染不抛错", () => {
    const node = {
        id: "n1",
        title: "音频",
        width: 380,
        height: 500,
        position: { x: 0, y: 0 },
        metadata: { ...plugin.nodes[0].defaultMetadata },
    };
    const ctx = {
        node,
        theme: { node: { text: "#eee", muted: "#999", stroke: "#ffffff33" } },
        getUpstream: () => [],
        updateMetadata: () => {},
        applyOps: () => {},
    };
    const tree = plugin.nodes[0].Content({ ctx });
    if (!tree || typeof tree !== "object") throw new Error("Content 没返回元素");
});
check("面板文案不含英文报错原串", () => {
    const n = plugin.nodes[0];
    if (/undefined|NaN/.test(`${n.title}${n.description}`)) throw new Error("文案里有 undefined/NaN");
});

let failed = 0;
for (const [name, ok, message] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  → " + message}`);
    if (!ok) failed += 1;
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
