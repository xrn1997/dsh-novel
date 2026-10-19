# 客户端文案归宿主 locale：TS 字典、单点、可选回退

浏览器半原先中文散在各组件里；宿主 `@deepseek-ai/dsh-client-locale` 提供运行期语言服务与按 revision 重渲的 slot `t` 席位。本轮把可见文案收进 `src/client/copy/**` 的域字典，并只经一个入口取词。

- **字典是 TS 模块，不是外挂资源**：每个域一个 `*_ZH`（真源）与 `*_EN`（逐键镜像）；`src/client/copy/index.tsx` 的 `ZH` / `EN` 合成单一键类型，`EN` 的 `Record<CopyKey, string>` 让漏键编译不过。`locale/` 目录的包元信息 JSON 仍只装插件卡片的标题/描述——那是宿主在激活前读的清单元信息，不是运行期 UI 字典。被否决：把字典做成 JSON / 另起 i18n 运行时——浏览器半是单文件 CJS，多一个加载面就多一截纯度门解释不了的依赖。
- **locale 服务可选读，不硬 inject**：`createTranslate(ctx)` 用 `ctx.get('locale')` 取服务；在 `ctx.effect` 里注册 `xrn1997-dsh-novel` 命名空间（register 的 disposer 是 HMR 重挂的退订口），服务缺席返回 `zhTranslate`。`package.json` 的 `dsh.client.inject` 只保证包按序到达，不产生运行时 import；服务本身由 locale 包的 `immediately` 在正常组合里先提供。apply 时读一次、晚到不追，是这条可选回退的已知边——宿主若把 locale 放晚，界面停在中文而不是半截。被否决：`inject = ['locale']` 硬挂——旧宿主没有该服务时这个插件不会被激活，而阅读主路径不依赖语言；这也是 `docs/adr/0020` 第 5 条「宿主服务硬 inject」的浏览器半例外（那条管 Node 半的 `webServer` / `tools` / `jobs`）。
- **slot 不声明 `locale` 席位，改走 `inject` + `CopyProvider`**：声明 `locale` 的 entry 在未安装 locale face 的宿主上会抛（宿主 renderer 的硬要求），与上一条的可选回退冲突。代价是语言切换靠 outlet 的 locale revision 重渲、`t` 在调用时读当前语言；组件不缓存译好的句子。被否决：用一个必然要求 locale face 的席位换掉可选回退。
- **错误只翻客户端自造的那一类**：`ApiClientError` 带 `reason` 标示 not-json / request-failed / stream-unavailable；`describeError` 只翻这三种，服务端错误原文透传（错误码与段级定位是数据）。被否决：按 message 前缀猜来源——那正是 `docs/adr/0016` 否掉的判据。
- **单点由机器面守**：`tests/client/copy-guard.test.ts` 用 TS AST 扫 `src/client/**` 的字符串 / 模板串 / JSX 文本里的中文，注释不算；白名单逐条带理由。`tests/client/copy.test.ts` 钉 ZH/EN 键集与重复键。已知限制：已进 transient / job / 会话快照或视图 state 的错误在生成时定语言，切换语言不重翻存量条目；不为此把 store / 视图 state 改成消息对象。
- **纯派生层不持 React 状态，但模块图会连带 React**：`city-view-model` / `search-view-model` / `shelf-view-model` 从 `src/client/copy/index.tsx` 取 `plural` / `zhTranslate`，而该文件同时导出 `useCopy` / `CopyProvider`。这些函数不碰 hook、测试仍在无 DOM 的 node 环境跑，模块加载却不证明「零 React」。被否决：为这三行 import 拆一个 `core.ts` 再两处 re-export——消费者要记住哪层带 React，收益只是模块图更纯；接受这层耦合，把它记在这里。

锚点：`src/client/copy/index.tsx` 的 `ZH` / `EN` / `createTranslate` / `zhTranslate` / `CopyProvider` / `useCopy`；`src/client/api.ts` 的 `describeError` / `NetworkReason`；`src/client/index.tsx` 的 `inject` 缝；`tests/client/copy-guard.test.ts`；`tests/client/copy.test.ts`；`tests/client/panel-registration.test.tsx`。
