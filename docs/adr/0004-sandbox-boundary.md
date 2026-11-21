# 沙箱边界：只有 JSON 可序列化的包装函数过界，eval 在 vm 内可用

Status: accepted

`@js` 脚本是不可信文本，三条硬边界：① 宿主**绝不**把函数或对象直接交给用户代码——`java` / `console` / `cookie` / `source` 全是 vm realm 里的包装函数，唯一入口 `__host_call__` 被引导层闭包捕获后即从全局锁死，参数与返回值双向 JSON 序列化；② vm 上下文 `codeGeneration: { strings: true, wasm: false }`：`eval` / `Function` 只在 vm realm 内可用，`require` / `process` / `fs` / `global` 不注入；`JavaImporter` 只枚举已挂载的 `Packages`，`java.net.URL.openConnection` 经同一守门 fetcher 出站、不开裸 socket；③ 给不了的安卓能力一律抛「需要安卓宿主环境」，不许静默 no-op。动机：要挡的是**跨 realm 的宿主入口**，不是字符串代码生成本身；`node:vm` 是纵深防御层，不是 OS 级安全沙箱。例外一起知道：纯 UI 副作用是明确的 no-op；真实文件系统不开，脚本读文件只能走 `downloadFile` 换来的不透明令牌。被否决：直接注入宿主对象、把代码生成降级成子集或由宿主代跑、给 wrapper 补 `'use strict'`。

锚点：`src/engine/js-sandbox.ts` 的 `BOOTSTRAP` 与桩名单；`src/engine/host-surface-elem.ts` 的 `elemWrapperSource` 与 `src/engine/host-surface-pkg.ts` 的 `pkgWrapperSource`；`src/engine/js-protocol.ts` 的 `readTxtFile` 注；`tests/engine/js-sandbox.test.ts`；矩阵行 `h-sandbox-escape-defense`、`h-js-lib-eval`、`h-rhino-javaimporter-scope`、`h-packages-url-connection`、`h-file-extra-apis`。
