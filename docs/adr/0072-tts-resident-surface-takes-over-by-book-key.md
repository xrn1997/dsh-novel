# 听书会话住模块级常驻播放层，常驻面按书键接管

Status: accepted

听书会话由模块级播放层持有，不绑在阅读器组件树上；阅读器内听书条与全局浮窗共读同一份会话，接管判据按**书键**对齐：阅读器在场书键集合里有会话本书时由就地条接管，否则浮窗接手——包括阅读器开着另一本书的那一格。

## 决定

- **会话归模块级 store**：播放单元、当前章段、引擎 / 音色 / 语速 / 音量、定时与连败计数都住 `client/tts/player.ts` 的 `ttsPlayer`；视图只订阅投影、只发动作。
- **阅读器条是就地控制器**：`TtsBar` 只在「正在听的会话就是本书」时挂载；条上的暂停 / 跳段 / 定时不重建会话。
- **常驻面按书键接管**：`reader-presence` 记阅读器子树的在场计数与在场书键多重集；浮窗可见性 = 会话在 ∧ 在场书键里没有会话本书。宿主切走面板导致阅读器子树卸载时浮窗出现；阅读器开着另一本时浮窗也出现——就地条不挂载的那一格不许控制面真空。
- **一次 inject 两枚条目**：浮窗与状态层合并为一次 `shell.overlay` 注入；两枚注册的退订一起还。
- **离开不停止**：打开其他书、切回书架或关闭阅读器都不结束会话；只有显式停止或会话失败到阈值才收口。
- **位置落盘**：播放层按书写 `listen` 与共用 `progress`；「回阅读器」只交接一次性重定位现场，不写阅读进度。

## 边界

- 不做宿主后台任务；常驻只跨**面板**卸载，不跨**插件**卸载（见 `ADR-0092`）。
- 不做双书并放：起播另一本会先停旧会话并 flush 旧书位置。
- 浮窗不另建第二份播放状态；书键按多重集记，同书挂两棵子树时撤一棵不该把另一棵的在场也撤掉。

## 被否方案

- 播放状态住阅读器组件：宿主切面板会卸载整个阅读器子树，声音停、定时丢。
- 阅读器条与浮窗各持一份会话：两份状态会漂移，合并规则本身就是第二个状态机。
- 按「阅读器子树在场」一刀切让浮窗退场：读另一本时控制面真空。
- 把会话做成服务端任务：听书出声在浏览器，会话生命周期没有跨进程必要。

锚点：`src/client/tts/player.ts` 的 `ttsPlayer` / `startListening` / `resumeListening` / `playFromReadingPosition`；`src/client/tts/TtsBar.tsx` 的 `TtsBar`；`src/client/tts/TtsMiniBar.tsx` 的 `TtsMiniBar`；`src/client/tts/reader-presence.ts` 的 `enterReader` / `readerPresence`；`src/client/index.tsx` 的 `shell.overlay` 双条目注入；`tests/client/tts-player.test.ts`；`tests/client/tts-mini.test.tsx`；`docs/ui-spec.md` §3.6；`ADR-0022`、`ADR-0073`。
