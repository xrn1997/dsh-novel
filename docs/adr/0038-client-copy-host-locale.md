# 客户端文案归宿主 locale：TS 字典、单点、可选回退

Status: accepted

浏览器半的可见文案收进 `src/client/copy/**` 的域字典，取词只经一个入口。**字典是 TS 模块**：每个域一个 `*_ZH`（真源）与 `*_EN`（逐键镜像），`ZH` / `EN` 合成单一键类型让漏键编译不过；`locale/` 的包元信息 JSON 仍只装插件卡片标题/描述。被否决：把字典做成 JSON / 另起 i18n 运行时（单文件 CJS 多一个加载面就多一截纯度门解释不了的依赖）。**locale 服务可选读**：`createTranslate(ctx)` 用 `ctx.get('locale')` 取服务，服务缺席返回 `zhTranslate`；`dsh.client.inject` 只保证包按序到达，不产生运行时 import；apply 时读一次、晚到不追。被否决：`inject = ['locale']` 硬挂（宿主未提供时插件不激活，而阅读主路径不依赖语言）——这也是 `ADR-0020` 第 5 条「宿主服务硬 inject」的浏览器半例外（那条管 Node 半的 `webServer` / `tools` / `jobs`）。**slot 不声明 `locale` 席位**，改走 `inject` + `CopyProvider`（声明 locale 的 entry 在未安装 locale face 的宿主上会抛）。**错误只翻客户端自造那一类**：`describeError` 只翻 not-json / request-failed / stream-unavailable，服务端错误原文透传。单点由 `tests/client/copy-guard.test.ts` 的 TS AST 扫中文守护。已知限制：已进 transient / job / 会话快照的错误在生成时定语言，切换语言不重翻存量条目。**纯派生层不持 React 状态，但模块图会连带 React**：三个 view-model 从 `copy/index.tsx` 取 `plural` / `zhTranslate`，而该文件同时导出 `useCopy` / `CopyProvider`——函数不碰 hook、测试在 node 环境跑，模块加载却不证明「零 React」；被否决：为这三行 import 拆 `core.ts`（消费者要记住哪层带 React）；接受这层耦合，记在这里。

锚点：`src/client/copy/index.tsx` 的 `ZH` / `EN` / `createTranslate` / `zhTranslate` / `CopyProvider` / `useCopy`；`src/client/api.ts` 的 `describeError` / `NetworkReason`；`src/client/index.tsx` 的 `inject` 缝；`tests/client/copy-guard.test.ts`；`tests/client/copy.test.ts`；`tests/client/panel-registration.test.tsx`。
