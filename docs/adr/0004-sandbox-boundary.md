# 沙箱边界：只有 JSON 可序列化的包装函数过界，eval 在 vm 内可用

`@js` 脚本是不可信的用户文本。三条硬边界：① 宿主**绝不**把函数或对象直接交给用户代码——`java` / `console` / `cookie` / `source` 全是 vm realm 里的包装函数，唯一入口 `__host_call__` 被引导层闭包捕获后即从全局锁死，参数与返回值双向 JSON 序列化；② vm 上下文 `codeGeneration: { strings: true, wasm: false }`：`eval` / `Function` 只在 vm realm 内可用，`require` / `process` / `fs` / `global` 不注入；`JavaImporter` 只枚举已挂载的 `Packages` 路径，`java.net.URL.openConnection` 经同一守门 fetcher 出站、不开裸 socket；③ 给不了的安卓能力一律抛「需要安卓宿主环境」，不许静默 no-op 或返假数据。

动机：沙箱要挡的是**跨 realm 的宿主入口**，不是字符串代码生成本身。宿主函数直接注入时，`console.log.constructor("return process")()` 可直达宿主 realm——vm 的 `codeGeneration` 只约束 vm realm，管不了宿主侧的 `Function`，所以入口锁死与双向 JSON 序列化才是边界。字符串代码生成放开后，vm 内可用 `eval` / `Function`；V8 在格式化错误栈时会把 CallSite 交给 `Error.prepareStackTrace`，worker 的 CJS 宿主帧曾可经 `getThis()` / `getFunction()` 取到宿主 `require`，现已在 `BOOTSTRAP` 把该属性锁成不可写、不可配置，并补主线程与 worker 两路钉子。**`node:vm` 是纵深防御层，不是 OS 级安全沙箱**，不宣称「宿主 realm 绝对不可达」。

被否决的方案：① 直接注入宿主对象/函数（就是那条逃逸路径）；② 把字符串代码生成降级成子集或由宿主代跑（真实源在规则脚本里用 `eval` / `new Function`——矩阵 `h-js-lib-eval` 的现量是 jsLib 字段 0/5、放宽到任意串 10/214；降级会让这些源读不出，vm 内放开已由入口锁死兜住）；③ 给 wrapper 补 `'use strict'`——防御靠 realm + 入口锁死，严格模式与它正交，补上反而杀掉依赖 sloppy 赋值写全局的真实目录脚本。

**例外要一起知道**：纯 UI 副作用（`toast` / `copyText` / `startBrowser` / `open`）是明确的 no-op——没有 UI 可动是事实，报「需要安卓宿主」反而把无副作用的空操作说成失败；「不许静默 no-op」管的是**取值与解密类**能力。同理，真实文件系统不开：脚本读文件只能走 `downloadFile` 换来的不透明令牌（书源脚本可读任意本地路径 = 数据外泄面）。

锚点：`src/engine/js-sandbox.ts` 的 `BOOTSTRAP` 与桩名单；`src/engine/js-protocol.ts` 的 `readTxtFile` 注；`tests/engine/js-sandbox.test.ts` 的「代码生成允许」与「宿主帧逃逸通道已锁」；矩阵行 `h-sandbox-escape-defense`、`h-js-lib-eval`、`h-rhino-javaimporter-scope`、`h-packages-url-connection`、`h-file-extra-apis`。
