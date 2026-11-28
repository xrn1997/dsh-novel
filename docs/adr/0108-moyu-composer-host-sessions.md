# 摸鱼输入框接宿主会话：插件只做入口，不代发任务

Status: accepted

输入框上一版被做成「真提交点」：绑定工作区后开会话并投递任务。那让一个阅读伪装层变成会花用户额度的执行者——插件要自己维护任务态、排队、撤销与失败面，而准入、计费、确认本来全归宿主。决定：**输入框只做阅读动作**；工作区 chip 是**入口**——在选定工作区开/切一个宿主会话并带到前台，此后由用户在宿主界面里使用。插件不投递、不排队、不撤销任何一轮。

## 决定

1. **入口只经宿主公开面**：`uiWorkspace.openWorkspace` 建/复用空白会话并带到前台（一次调用完成连接与打开）；会话身份从它的 `beforeOpen` 回执取，不另调 `create`、不 `conversation.send`。不 URL 黑魔法、不剪贴板注入、不在 Node 半自建通道。
2. **作用域只借来读**：入口会话先 `sessions.retain(id, { source: 'moyuStage' })`（`source` 经包主官宣的声明合并登记），镜像再经 `uiConversation.binding(id).target('chat')` 读；`retain` 只保持本地会话数据、scoped Context 与历史流，不启动 Host Agent。
3. **输入框语义不变**：Enter / 发送钮只把草稿沉成本轮用户气泡并进下一章；「继续生成」、队列消息、撤销、停止都不存在（没有任务可管）。
4. **副作用只有建/切会话**：入口由用户显式点选工作区触发；插件侧不存在可花费额度的路径，因此不需要第二道确认。
5. **缺席即隐藏**：工作区枚举面或打开面缺席＝chip 隐藏；镜像读取面缺席＝不镜像（入口照常成功）。每格单独降级，不炸面板。

## 边界

- `ADR-0107` 的「不改 Node 半、不新增 wire 路由、舞台只覆盖插件主内容区」不变。
- 镜像只读：只订阅宿主 chat 快照，不 `loadOlder`、不改写、不撤销；未映射节点＝中性占位、形状漂移＝该轮降级（失败半径＝那一轮）。
- 章进度、正文投影、听书与文件坞语义不变；入口动作不写阅读进度。
- 「浏览更多插件」只到 Plugins 面板 installed 列表；Discover tab 没有公开的直达动词，这是宿主缺口，不绕道伪造。
- **没有「创建你的插件」菜单行**：那条路会用原文 prompt 起一轮真会话（＝代发），归宿主自己的入口。

## 被否方案

- **输入框绑定后直接投递**（上一版做法）：插件变成执行者，要自建任务态、队列、撤销与失败面，每次误触都是真轮次；准入与计费全归宿主，插件没有一层替它兜底。
- **装饰性入口**：工作区 chip 做成摆设——摸鱼模式的既定原则是「输入框要真能用」，假按钮比没有更糟；真的入口是开会话，不是替用户干活。
- **自建投递通道**（URL 黑魔法 / 剪贴板注入 / Node 半 HTTP）：绕开宿主准入与权限，随宿主改版即碎。
- **保留「创建你的插件」行**：它起真会话，与「不代发」冲突。

## 后果

- 任务与队列面整体退场：`moyu-host.ts` 只剩端口、工作区枚举、入口与镜像；舞台删掉状态条、任务钮、预设胶囊、附件行与发送三态。
- 镜像仍按书归因：入口时的书决定镜像轮进入哪本书的对话流；换入口＝旧镜像清场、旧引用释放。
- 类型面只借不依赖见 `ADR-0109`；宿主服务读法只走 `ctx.get`——属性访问对未 inject 的服务会抛并带走整个 client fiber（`tests/client/host-inject-guard.test.ts`）。
- 真轮次镜像的成本只剩「一枚入口会话长持一份引用 + 一路 chat 订阅」；换工作区或拆 fiber 时统一释放。

锚点：`src/client/moyu-host.ts` 的 `MoyuHostPort` / `moyuHostPortOf` / `openMoyuWorkspaceSession` / `conversationBindingOf`；`src/client/moyu-mirror.ts` 的 `projectMoyuMirrorTurns`；`src/client/views/MoyuStage.tsx` 的 `openWorkspaceSession` / `renderMirrorTurn`；`tests/client/moyu-host.test.ts`；`tests/client/moyu-stage.test.tsx`；`tests/client/host-inject-guard.test.ts`；`ADR-0107`、`ADR-0109`。