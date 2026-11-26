# 翻页听书底栏出流浮动，阅读重排一律走内容段落锚点并统一双模式排版

Status: accepted

翻页模式下听书条按文档流占位会瞬间压低书页舞台高度并触发全章重排，且滚动纯文本与翻页同章重排缺少段落锚点，导致开关听书、调字号或缩放窗口时正文不停跳变。决定：**翻页模式下听书条出流成底部悬浮岛（不改舞台高度与页码），两种阅读模式的同章重排统一以当前可见段落为锚点重新落位，并统一正文段距/章标题字阶与开放翻页分栏布局选择（自动 / 单页 / 双页）。**

## 决定

1. **听书条出流语义分离**：滚动模式下 `.novel-tts-bar` 保持 `sticky bottom: 0`（随文档流吸附底边，本来就不挤占 `.novel-rdr-body` 宽度）；翻页模式下 `.novel-rdr.is-paged .novel-tts-bar` 改为 `position: absolute` 底部居中紧凑浮岛（隐藏预览行、窄屏隐去非空章段读数但保留空章提示，失败提示收成单行紧凑提示），同时听书在场时（`.novel-rdr.is-paged.is-tts-open`）翻页页脚 `.novel-book-footer` 就地隐去让位（`visibility: hidden; pointer-events: none`）并保留 20px 舞台底距（`STAGE_PAD_Y = 108`），使开关听书与出现失败提示都不改变 `.novel-book-stage` 的尺寸与总页数，也不遮挡页脚与末行正文。
2. **滚动模式纯文本排版复位锚点**：`currentNodeOf` 与 `createReaderGeometry` 对未带 `data-novel-node` 的纯文本章回落读取 `[data-pidx]`（以 `pidx:` 前缀进同一条 `VisibleNode` 与 `targetOffset` 通道），使在线书与本地 TXT 调整字号、行距、栏宽时也能通过 `applyTypesetRelocation` 锚定到原段落。
3. **翻页模式内容锚点防漂移**：`BookStage` 用同步布局测量（`useLayoutEffect`）消除首帧默认尺寸的伪重排，并维护当前屏首段 `anchorParagraphRef`；同章重排（字号、行距、栏宽、窗口尺寸、单双页切换）直接按该段号定位目标屏，不再每次回退到 `spreadForRatio` 向下取整导致连续向回漂移；滚动→翻页交接后的 `modeAnchorRef` 在消费后立即清理，防止污染后续跨章跳转。
4. **双模式排版统一、分栏可选与栏宽字号解耦**：对齐 `.novel-rdr-body` 与 `.novel-book-track` 的段间距及 `h2.novel-rdr-mark` 章标题样式（并保留注释面板 `.novel-notes .novel-body p` 的紧凑间距）；在阅读偏好新增 `pageColumns`（`auto | single | double`），`computeSpreadLayout` 支持显式单页/双页或按 `DOUBLE_PAGE_MIN_WIDTH` 自动切换。同时修正 `ADR-0101` 中栏宽按 `em × fontSize` 随字号伸缩的设计：改为与字号解耦的固定像素档位 `520 / 600 / 680 / 820 px`（默认 `680px`），翻页双页每栏上限按 `DOUBLE_PAGE_COLUMN_SCALE`（`0.8`）缩放后仍受舞台可用宽度夹取；旧版持久化的 `em` 栏宽经 `normalizeMeasure` 无缝迁移为像素值。

## 边界

- 跨会话或跨重启的持久化进度仍只存 `chapterIndex + offsetRatio`（`ShelfBook.progress`）；运行期段落锚点只在内存窗口内生效，不改变服务端 wire 形状。
- 翻页模式下页内跨章锚点与返回栈精度边界仍按 `ADR-0101` 保持不变。

## 被否方案

- **翻页模式始终预留固定高度给听书条**：不听书时底部白白浪费近 100px 舞台高度，且条高变化（如错误提示换行）仍会触发重排。
- **翻页重排只靠 `ratioRef` 四舍五入缓解**：不同宽高的栏宽变化是非线性的，比例换算在窄幅缩放与字号连续调整下仍会逐步偏离当前正在读的段落。
- **保留 `em` 单位栏宽**：改字号时会直接撑宽/收窄正文列与翻页书封，交互上被用户感知为「整页拉伸」而非纯粹调字号。

锚点：`src/client/styles/tts.ts` 的 `.novel-rdr.is-paged .novel-tts-bar`；`src/client/styles/reader.ts` 的 `.novel-book-track h2.novel-rdr-mark` / `.novel-body p`；`src/client/reader-geometry.ts` 的 `currentNodeOf` / `createReaderGeometry`；`src/client/views/BookStage.tsx`；`src/client/views/ReaderView.tsx`；`src/client/reader-pagination.ts` 的 `computeSpreadLayout` / `DOUBLE_PAGE_MIN_WIDTH` / `DOUBLE_PAGE_FORCE_MIN_WIDTH` / `DOUBLE_PAGE_COLUMN_SCALE`；`src/client/prefs-ui.ts` 的 `MEASURES`；`src/client/store.ts` 的 `PageColumns` / `normalizeMeasure`；`src/client/views/PrefsPanel.tsx`；`tests/client/reader-geometry.test.ts`；`tests/client/book-stage.test.tsx`；`tests/client/reader-pagination.test.ts`；`tests/browser/book-stage-layout.test.tsx`；`docs/ui-spec.md` §3.5 / §3.6；`ADR-0101`。
