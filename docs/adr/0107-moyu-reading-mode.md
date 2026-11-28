# 摸鱼模式收编为第三种阅读方式，复用按章推进会话而不新增进度通道

Status: accepted

阅读器已经形成滚动与翻页两条正式阅读路径；摸鱼呈现若另做独立开关，会把模式切换、快捷键、章节进度和浮层层序再复制一套。决定：把摸鱼收编为 `ReadingMode` 第三档，视觉模式与底层会话推进方式分开，并让新舞台复用现有阅读会话与阅读场景。

## 决定

1. **正式阅读方式**：`ReadingMode` 为 `scroll | page | moyu`；`lastNormalMode` 只记 `scroll | page`，进入摸鱼时保持不变，退出时恢复。`moyuStyle` 与 `moyuReveal` 是呈现偏好，不拥有业务状态。
2. **视觉与会话分开**：`scroll` 挂滚动绑定；`page` 与 `moyu` 都调用 `ReaderSession.setPaged(true)`，但只有 `page` 挂 `BookStage`。摸鱼因此复用无滚动视口的按章推进路径，不需要给会话新增第三种状态。
3. **进度只跟章节动作**：流式揭示、对话流内部滚动和听书段推进不写消费位置；输入框、上下章、`/` 指令与 `@` 章节引用、预览里的「在阅读器打开」和听书跨章调用 `requestJump`，沿原有 commit / 防抖管道落盘。文件树行只开文档预览 tab、不切章。退出摸鱼时按进入前锚点交还滚动或翻页视图。
4. **舞台只覆盖插件主内容区**：`MoyuStage` 使用宿主色 token 呈现对话流、输入框、统计条和文件坞；不绘制、查询或修改宿主左侧栏。窄屏文件坞收成覆盖抽屉。
5. **浮层仍归阅读场景**：菜单只发 `ReaderScene.toggle` 与导出命令，设置 / 导出 / 导入说明 / 补充正文由 `ReaderView` 唯一渲染；摸鱼本地菜单、README 与文件搜索通过 `claimKeyLayer` 参与同一 Esc 层序。
6. **正文投影不另造一份**：文字沿用 `chapterContentLines`；图文树只提取段落、内链与折叠插图附件，图片默认不直接展开。

## 边界

- 不改 Node 半的抓取、规则、存储、API 或工具面，也不新增 wire 路由。
- 摸鱼不是独立于阅读器的页面；书身份、目录、正文载荷、进度和听书播放仍归现有模块。
- 听书段号只决定高亮；只有听书跨章才触发章节导航，避免播放层偷偷改写阅读进度。
- 宿主左侧栏始终由宿主负责，插件只伪装自己的主内容区。

## 被否方案

- **把摸鱼做成覆盖在 ReaderView 上的独立布尔开关**：模式切换、`lastNormalMode`、快捷键和章节窗口会出现两套真值，退出时也难以交还正确锚点。
- **摸鱼继续用非 paged 会话，再增加“暂停滚动写进度”开关**：需要在 `ReaderSession` 新开进度抑制状态，并处理 TTS follow、pending reveal 与滚动补偿的交叉，比复用 paged 路径更宽。
- **让 MoyuStage 自己持有设置 / 导出 / 导入浮层**：会与 `ReaderScene` 双重挂载，产生两个 Esc、遮罩和焦点主人。
- **直接把 EPUB HTML 或图片资源名拼进舞台**：当前 wire 是规范化 `ContentNode[]`，图片只有 `resourceId` 与 `alt`；绕过共享投影会制造第二份正文语义并扩大注入面。

## 后果

- `ReaderView` 的模式布尔从“一个 `isPaged` 管全部”拆成视觉模式与 `sessionPaged`，这是客户端编排层的小幅收紧，不是业务重写。
- 摸鱼阶段的章内位置不保留文本比例，只保留进入前锚点与当前章；这是换取进度策略简单、可解释的代价。
- 新增长期偏好字段与一套客户端文案 / 样式；旧偏好读取时按缺省值收敛。
- 守护落在纯函数、舞台组件、ReaderView 接线、文案 / token 守卫与文档门；真实固定舞台几何另由浏览器门验证。

锚点：`src/client/store.ts` 的 `ReadingMode` / `Prefs` / `setPref`；`src/client/moyu-stream.ts`；`src/client/views/MoyuStage.tsx`；`src/client/views/ReaderView.tsx` 的 `isScrollView` / `isPaged` / `isMoyu` / `sessionPaged`；`src/client/reader-session.ts` 的 `setPaged` / `requestJump`；`src/client/reader-scene.ts` 的 `ReaderScene`；`src/client/views/dialog.tsx` 的 `claimKeyLayer`；`tests/client/moyu-stream.test.ts`；`tests/client/moyu-stage.test.tsx`；`tests/client/wiring-reader.test.tsx`；`tests/browser/moyu-stage-layout.test.tsx`；`docs/ui-spec.md` §3.5。
