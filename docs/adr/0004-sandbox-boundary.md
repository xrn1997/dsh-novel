# 沙箱边界：只有 JSON 可序列化的包装函数过界，字符串代码生成明确不支持

`@js` 脚本是不可信的用户文本。三条硬边界：① 宿主**绝不**把函数或对象直接交给用户代码——`java` / `console` / `cookie` / `source` 全是 vm realm 里的包装函数，唯一入口被引导层闭包捕获后即从全局锁死，参数与返回值双向 JSON 序列化；② 上下文 `codeGeneration: { strings: false, wasm: false }`，`require` / `process` / `fs` / `global` 不注入；③ 给不了的安卓能力一律抛「需要安卓宿主环境」，不许静默 no-op 或返假数据。

动机：此前把宿主函数直接注入，`console.log.constructor("return process")()` 可直达宿主 realm——vm 的 `codeGeneration` 只约束 vm realm，管不了宿主侧的 `Function`。所以 `jsLib` 里用 `eval` / `new Function` 的源报 "Code generation from strings disallowed" 是**安全边界的既定后果**，明确不支持，不做「凑合能跑」的降级。

被否决的方案：① 直接注入宿主对象/函数（就是那条逃逸路径）；② 把字符串代码生成降级成子集或由宿主代跑；③ 给 wrapper 补 `'use strict'`——防御靠 realm + codeGeneration + 入口锁死，严格模式与它正交，补上反而杀掉依赖 sloppy 赋值写全局的真实目录脚本。

**例外要一起知道**：纯 UI 副作用（`toast` / `copyText` / `startBrowser` / `open`）是明确的 no-op——没有 UI 可动是事实，报「需要安卓宿主」反而把无副作用的空操作说成失败；「不许静默 no-op」管的是**取值与解密类**能力。同理，真实文件系统不开：脚本读文件只能走 `downloadFile` 换来的不透明令牌（书源脚本可读任意本地路径 = 数据外泄面）。

锚点：`src/engine/js-sandbox.ts` 的 `BOOTSTRAP` 与桩名单；`src/engine/js-protocol.ts` 的 `readTxtFile` 注；`tests/engine/js-sandbox.test.ts` 的逃逸三组；矩阵行 `h-sandbox-escape-defense`、`h-js-lib-eval`、`h-file-extra-apis`。
