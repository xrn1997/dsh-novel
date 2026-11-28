/** 摸鱼舞台的样式块：按宿主会话界面的真几何拼一遍`对话流 + 文件坞`。
 *
 *  量值取自宿主的真样式表，不凭截图描：会话头 76px（10px 顶排 + 30px 标题行 + 标签行余量）、
 *  正文列 `clamp(680px, 64%, 920px)`、
 *  输入卡 `列宽 + 32px` 与 28px 圆角、进程行 33px、披露行 24px、文件坞 264px（38px
 *  标签条 + 38px 文件头）。像素写成本地几何变量，色值只读 `--novel-*` 语义层——宿主换
 *  主题 / 换品牌色时整台舞台跟着走，不需要第二套色表。
 *
 *  作用域纪律：舞台只盖插件主内容区（`.novel-moyu-stage` 由 `MoyuStage` 量
 *  `[data-novel-main]` 后写 left/top/width/height），不查询也不改宿主左栏；窄屏文件坞
 *  收成覆盖抽屉，但舞台本体的盒模型不变。 */
export const MOYU_CSS = `
/* ═══ 舞台骨架 ═══════════════════════════════════════════════════════════ */
.novel-moyu-stage {
  /* 宿主会话几何：头 76 / 坞宽可拖（D9：min 300、初始 320，宽度走 --novel-moyu-dock-w 值槽）/
     正文列 64%（680~920）/ 输入卡列宽 + 32 / 侧清障 16 */
  --novel-moyu-topbar-h: 76px;
  --novel-moyu-dock-w: 320px;
  --novel-moyu-clearance: 16px;
  --novel-moyu-column-w: clamp(680px, 64%, 920px);
  --novel-moyu-tab-hit: 10px;
  --novel-moyu-side: calc(var(--novel-moyu-clearance) + var(--novel-moyu-clearance));
  position: fixed;
  left: 0;
  top: 0;
  z-index: calc(var(--novel-z-modal) - 1);
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  color: var(--novel-text);
  background: var(--novel-bg);
  font-family: var(--novel-font-text);
  /* 字号轴跟宿主「字号」设置（--dsh-content-font-size，10–22px 整数，默认 14）；行距随
     宿主的 px delta 联动。 */
  font-size: var(--dsh-content-font-size, 14px);
  line-height: 1.6;
}
.novel-moyu-stage *, .novel-moyu-stage *::before, .novel-moyu-stage *::after { box-sizing: border-box; }
.novel-moyu-stage :where(button, input, textarea) { font: inherit; }
.novel-moyu-stage button { color: inherit; cursor: pointer; }
.novel-moyu-stage button:disabled { cursor: default; }
.novel-moyu-stage button:focus-visible, .novel-moyu-stage input:focus-visible,
.novel-moyu-stage textarea:focus-visible { outline: 2px solid var(--novel-ring); outline-offset: 1px; }
.novel-moyu-stage svg { fill: none; stroke: currentColor; stroke-width: 1; stroke-linecap: round; stroke-linejoin: round; }
.novel-moyu-stage svg.novel-moyu-svg-fill { fill: currentColor; stroke: none; }
.novel-moyu-shell { display: flex; flex: 1; min-height: 0; }
.novel-moyu-main {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--novel-bg);
}

/* ═══ 会话头：两行，76px（宿主 ConversationHeader） ═════════════════════ */
.novel-moyu-header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  flex: none;
  min-height: var(--novel-moyu-topbar-h);
  padding: 10px 28px 0 20px;
  border-bottom: 0.5px solid var(--novel-border-mid);
}
.novel-moyu-header-leading { grid-column: 1; grid-row: 1; display: flex; align-items: center; gap: var(--novel-sp-2); }
.novel-moyu-title-row {
  grid-column: 2;
  /* 宿主 titleRow 的同款：行宽容器（标题簇按行宽断点让字）+ macOS 红绿灯让位（无桌面壳时为 0）。 */
  container-type: inline-size;
  display: flex;
  align-items: center;
  gap: 0;
  min-width: 0;
  min-height: 30px;
  padding-inline-start: max(0px, calc(var(--dsh-frame-leading-clearance, 0px) - 20px));
}
.novel-moyu-title-cluster {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 10px;
  min-width: 0;
  --title-cluster-fade: 20px;
  margin: -4px calc(-1 * var(--title-cluster-fade)) -4px -4px;
  padding: 4px var(--title-cluster-fade) 4px 4px;
  overflow: clip;
  /* 超宽时右缘渐隐（宿主 titleCluster 的 mask 口径）。 */
  mask-image: linear-gradient(to left, transparent calc(0.3 * var(--title-cluster-fade)), currentColor var(--title-cluster-fade));
}
.novel-moyu-crumbs {
  display: flex;
  align-items: center;
  gap: var(--novel-sp-1);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.novel-moyu-crumb {
  display: inline-block;
  max-width: 220px;
  overflow: hidden;
  padding: var(--novel-sp-1) var(--novel-sp-3);
  border: 0;
  border-radius: var(--novel-r-lg);
  background: transparent;
  color: var(--novel-text-3);
  font-size: var(--novel-fs-base);
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
@media (hover: hover) {
  button.novel-moyu-crumb:hover { background: var(--novel-hover); }
}
.novel-moyu-crumb.is-current { color: var(--novel-text); font-weight: 500; cursor: default; }
.novel-moyu-crumb.is-current:hover { background: transparent; }
.novel-moyu-crumb-sep { color: var(--novel-caption); font-size: var(--novel-fs-base); line-height: 20px; }
.novel-moyu-header-utilities { display: flex; flex: none; align-items: center; gap: var(--novel-sp-3); margin-left: 20px; }
.novel-moyu-header-corner { display: flex; flex: none; align-items: center; margin-left: 8px; margin-right: -16px; }
/* 宿主 .headerCorner:empty 同款：坞展开时右角整位收掉。 */
.novel-moyu-header-corner:empty { display: none; }
/* 头/坞的 28px 线稿钮（宿主 dockkit 「.iconButton」 形态：radius-sm、hover 只加底色、禁用 .4）。 */
.novel-moyu-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--novel-r-sm);
  background: transparent;
  color: var(--novel-text-2);
}
@media (hover: hover) {
  .novel-moyu-icon-btn:hover:not(:disabled) { background: var(--novel-hover); }
}
.novel-moyu-icon-btn:disabled { opacity: .4; }
.novel-moyu-icon-btn svg { width: 15px; height: 15px; flex: none; }
/* 文件坞文件头的工具钮（宿主 FilesBody 「.tool」：hover 底+字色、展开态保底）。 */
.novel-moyu-tool {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 6px;
  border: 0;
  border-radius: var(--novel-r-sm);
  background: transparent;
  color: var(--novel-text-2);
  line-height: 1;
}
@media (hover: hover) {
  .novel-moyu-tool:hover:not(:disabled) { background: var(--novel-hover); color: var(--novel-text); }
}
.novel-moyu-tool[aria-pressed='true'],
.novel-moyu-tool[aria-expanded='true'] { background: var(--novel-hover); color: var(--novel-text); }
.novel-moyu-tool:disabled { opacity: .4; }
.novel-moyu-tool svg { width: 15px; height: 15px; flex: none; }

.novel-moyu-tabs-row {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  grid-column: 1 / -1;
  align-items: flex-start;
  gap: 16px 20px;
  width: 100%;
  min-width: 0;
  margin-top: 10px;
  padding-left: 8px;
}
.novel-moyu-view-tabs { display: flex; flex-wrap: wrap; gap: 32px; min-width: 0; min-height: 25px; }
.novel-moyu-tab {
  position: relative;
  min-height: 35px;
  margin: -10px calc(-1 * var(--novel-moyu-tab-hit)) 0;
  padding: 10px var(--novel-moyu-tab-hit) 9px;
  border: 0;
  background: transparent;
  color: var(--novel-text-3);
  font-size: var(--novel-fs-md);
  font-weight: 500;
  line-height: 16px;
}
.novel-moyu-tab-label { display: block; max-width: 88px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.novel-moyu-tab::after {
  position: absolute;
  right: var(--novel-moyu-tab-hit);
  bottom: -1px;
  left: var(--novel-moyu-tab-hit);
  height: 2px;
  border-radius: 2px;
  background: transparent;
  content: '';
}
.novel-moyu-tab.is-on { color: var(--novel-business); }
.novel-moyu-tab.is-on::after { background: var(--novel-business); }
.novel-moyu-tabs-more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-top: -3px;
  padding: 0;
  border: 0;
  border-radius: var(--novel-r-md);
  background: transparent;
  color: var(--novel-text-2);
}
.novel-moyu-tabs-more:hover { background: var(--novel-hover); }
.novel-moyu-tabs-more[aria-expanded="true"] { background: var(--novel-hover); }
.novel-moyu-tabs-more svg { width: 13px; height: 13px; }

/* ═══ 会话体：滚动列 + 吸底输入座 ══════════════════════════════════════ */
.novel-moyu-body { position: relative; display: flex; flex: 1; flex-direction: column; min-height: 0; overflow: hidden; }
.novel-moyu-scroll {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  margin-right: 2px;
  overflow-x: clip;
  overflow-y: auto;
  overscroll-behavior-y: none;
  scrollbar-gutter: stable;
}
.novel-moyu-view-area { display: flex; flex: 1 0 auto; flex-direction: column; min-height: auto; }
.novel-moyu-flow-wrap { padding: 16px calc(var(--novel-moyu-clearance) + 16px) 24px; }
.novel-moyu-column {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: var(--novel-moyu-column-w);
  margin: 0 auto;
}

/* ═══ 一个对话轮：用户气泡 → 过程 → 正文 → 尾栏 ═══════════════════════ */
.novel-moyu-turn { display: flex; flex-direction: column; }
.novel-moyu-turn + .novel-moyu-turn { margin-top: 28px; }
.novel-moyu-user-row { display: flex; flex-direction: column; align-items: flex-end; gap: var(--novel-sp-2); }
.novel-moyu-user-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--novel-sp-3);
  min-width: 0;
  /* 宿主 MessageItem 「.userStack」 的同款：525px 图帽按宽度轴折成 0.702，上限 82%。 */
  max-width: min(calc(var(--novel-moyu-column-w) * 0.702), 82%);
}
.novel-moyu-user-bubble {
  max-width: 100%;
  padding: 10px 16px;
  border-radius: var(--novel-r-xl);
  background: var(--novel-bubble);
  color: var(--novel-text);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(22px + var(--dsh-content-font-delta, 0px));
  white-space: pre-wrap;
  word-break: break-word;
}
/* 用户行动作（M5：宿主 MessageIconActions 的 user 面——时刻常显在前、复制在后）。 */
.novel-moyu-user-actions {
  display: flex;
  align-items: center;
  gap: var(--novel-sp-2);
  height: 28px;
}
.novel-moyu-user-time {
  padding-right: 12px;
  color: var(--novel-text-3);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta-secondary, 0px));
  white-space: nowrap;
}

.novel-moyu-process-hdr {
  display: flex;
  align-items: center;
  width: 100%;
  height: 33px;
  margin-top: 16px;
  padding: 0 0 8px;
  border: none;
  border-bottom: 0.5px solid var(--novel-border);
  background: none;
  color: var(--novel-text-3);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  text-align: left;
  transition: color 100ms ease;
}
.novel-moyu-process-hdr:hover { color: var(--novel-text-2); }
.novel-moyu-process-dur { font-family: var(--novel-font-mono); font-variant-numeric: tabular-nums; }
.novel-moyu-process-chevron { flex: none; width: 14px; height: 14px; margin-left: var(--novel-sp-1); transition: transform 100ms ease; }
.novel-moyu-process-hdr[aria-expanded="true"] .novel-moyu-process-chevron { transform: rotate(180deg); }

.novel-moyu-process-group { display: flex; flex-direction: column; gap: var(--novel-sp-1); margin-top: var(--novel-sp-4); }
.novel-moyu-disclosure { display: flex; flex-direction: column; width: 100%; min-width: 0; }
.novel-moyu-disclosure-line {
  display: flex;
  align-items: center;
  width: 100%;
  height: 24px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--novel-text-3);
  text-align: left;
  transition: color 100ms ease;
}
.novel-moyu-disclosure-line:hover { color: var(--novel-text-2); }
/* 摘要带独立 fileLink 的行：整行只是容器，可点区收在 leading + 标题上（按钮不许互套）。 */
.novel-moyu-disclosure-toggle {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.novel-moyu-disclosure-leading {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-right: var(--novel-sp-2);
  color: inherit;
}
.novel-moyu-disclosure-leading svg { width: 14px; height: 14px; flex: none; }
.novel-moyu-disclosure-icon { display: inline-flex; opacity: 1; transition: opacity 100ms ease; }
.novel-moyu-disclosure-chevron { position: absolute; inset: 0; margin: auto; opacity: 0; transition: opacity 100ms ease; }
/* hover 交换只在真指针设备上（宿主同款门控）；展开后 leading 换 chevron-up、图标消失。 */
@media (hover: hover) {
  .novel-moyu-disclosure-line[data-expandable="true"]:hover .novel-moyu-disclosure-icon { opacity: 0; }
  .novel-moyu-disclosure-line[data-expandable="true"]:hover .novel-moyu-disclosure-chevron { opacity: 1; }
}
.novel-moyu-disclosure-line[data-expanded="true"] .novel-moyu-disclosure-icon { opacity: 0; }
.novel-moyu-disclosure-line[data-expanded="true"] .novel-moyu-disclosure-chevron { opacity: 1; }
/* 展开时行头吸顶（宿主 ReasoningRow 的 disclosure-header 口径）。 */
.novel-moyu-disclosure[data-open] .novel-moyu-disclosure-line {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--novel-bg);
}
.novel-moyu-disclosure-title { flex: none; font-size: var(--dsh-content-font-size-secondary, 13px); font-weight: 400; line-height: calc(24px + var(--dsh-content-font-delta, 0px)); color: inherit; }
.novel-moyu-disclosure-sep {
  flex: none;
  width: 2px;
  height: 2px;
  margin: 0 var(--novel-sp-3);
  border-radius: 1px;
  background: var(--novel-caption);
}
.novel-moyu-disclosure-summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 摘要里的文件路径（宿主 fileLink 形态：虚线下划线、可点开文件）。 */
.novel-moyu-file-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  cursor: pointer;
}
/* 流式中摘要右缘 48px 渐隐（宿主 .summary[data-streaming] 的 mask 口径）。 */
.novel-moyu-disclosure-summary.is-streaming {
  -webkit-mask-image: linear-gradient(to right, black calc(100% - 48px), transparent);
  mask-image: linear-gradient(to right, black calc(100% - 48px), transparent);
  text-overflow: clip;
}
.novel-moyu-think-body {
  /* 宿主 compact Markdown 的 13/20（secondary 字阶 + delta 联动）三级灰正文。 */
  padding: var(--novel-sp-1) 0 var(--novel-sp-1) 22px;
  color: var(--novel-text-3);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  white-space: pre-wrap;
}
.novel-moyu-shimmer { position: relative; display: inline-block; }
.novel-moyu-shimmer[data-active="true"] {
  color: transparent;
  /* 扫光的三段基色必须写成 token 而不用 currentColor：color 置透明后
     currentColor 也跟着透明，标题会整条消失（原型里同一条 bug）。 */
  background-image: linear-gradient(105deg, var(--novel-text-3) 0%, var(--novel-text-3) 38%,
    var(--novel-shimmer) 50%, var(--novel-text-3) 62%, var(--novel-text-3) 100%);
  background-clip: text;
  -webkit-background-clip: text;
  background-size: 220% 100%;
  animation: novel-moyu-text-shimmer 1.6s linear infinite;
}
@keyframes novel-moyu-text-shimmer {
  from { background-position: 100% 0; }
  to { background-position: -100% 0; }
}

/* 助手正文（宿主 AssistantMarkdown 的 14/24、块距 16） */
.novel-moyu-assistant-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: var(--novel-sp-4);
  color: var(--novel-text);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
}
.novel-moyu-p { margin: 0; overflow-wrap: break-word; white-space: pre-wrap; }
.novel-moyu-p.is-small { color: var(--novel-text-2); font-size: var(--novel-fs-md); line-height: 20px; }
.novel-moyu-p.is-live {
  color: transparent;
  background-image: linear-gradient(100deg, var(--novel-text) 0%, var(--novel-text) 44%,
    var(--novel-business) 50%, var(--novel-text) 56%, var(--novel-text) 100%);
  background-clip: text;
  -webkit-background-clip: text;
  background-size: 200% 100%;
  animation: novel-moyu-live-sweep 1.5s linear infinite;
}
.novel-moyu-p.is-small.is-live {
  background-image: linear-gradient(100deg, var(--novel-text-2) 0%, var(--novel-text-2) 44%,
    var(--novel-business) 50%, var(--novel-text-2) 56%, var(--novel-text-2) 100%);
}
@keyframes novel-moyu-live-sweep {
  from { background-position: 100% 0; }
  to { background-position: 0 0; }
}
.novel-moyu-p.is-tts-live { padding-left: 10px; border-left: 2px solid var(--novel-business); }
.novel-moyu-mark { margin-inline-end: 5px; color: var(--novel-text-3); font-family: var(--novel-font-mono); }
.novel-moyu-h4 {
  display: flex;
  align-items: center;
  gap: var(--novel-sp-3);
  /* 宿主 AssistantMarkdown 的 h4 间距（16px 0；紧凑变体 8/4 另档）。 */
  margin: 16px 0;
  color: var(--novel-text);
  font-size: var(--dsh-content-font-size, 14px);
  font-weight: 600;
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
}
.novel-moyu-inline-code {
  /* 宿主 markdown 行内码芯片：0 5px / radius-sm / 0.875em / l1 发丝边。 */
  padding: 0 5px;
  border: 0.5px solid var(--novel-border-faint);
  border-radius: var(--novel-r-sm);
  background: var(--novel-inline-code);
  color: var(--novel-text-2);
  font-family: var(--novel-font-mono);
  font-size: 0.875em;
  font-weight: 400;
}
.novel-moyu-link {
  /* 宿主 markdown 内链：alias-link / 500 / 默认无下划线，hover·focus 点线下划线 offset 3；
     透明描边是宿主的点按热区加宽手法（同宽负 margin 抵掉，不改行内度量）。 */
  padding: 0;
  border: 0;
  border-left: 3px solid transparent;
  border-right: 3px solid transparent;
  border-top: 2px solid transparent;
  border-bottom: 2px solid transparent;
  margin-left: -3px;
  margin-right: -3px;
  background: transparent;
  color: var(--novel-link);
  font-weight: 500;
  text-decoration: none;
}
@media (hover: hover) {
  .novel-moyu-link:hover {
    outline: none;
    text-decoration: underline dotted var(--novel-link);
    text-underline-offset: 3px;
  }
}
.novel-moyu-link:focus {
  outline: none;
  text-decoration: underline dotted var(--novel-link);
  text-underline-offset: 3px;
}

/* 折叠插图：宿主 FileCard 附件条 */
.novel-moyu-illust-wrap { display: flex; flex-direction: column; gap: var(--novel-sp-3); align-items: flex-start; }
.novel-moyu-illust-card {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  padding: 7px 12px;
  border: 0.5px solid var(--novel-border);
  border-radius: var(--novel-r-md);
  background: var(--novel-layer-1);
  color: var(--novel-text-2);
  font-size: 12.5px;
  text-align: left;
}
.novel-moyu-illust-card:hover { background: var(--novel-hover); color: var(--novel-text); }
.novel-moyu-illust-name {
  overflow: hidden;
  color: var(--novel-text);
  font-family: var(--novel-font-mono);
  font-size: var(--novel-fs-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.novel-moyu-illust-meta {
  color: var(--novel-text-3);
  font-family: var(--novel-font-mono);
  font-size: var(--novel-fs-xs);
  white-space: nowrap;
}
.novel-moyu-illust-preview {
  display: flex;
  flex-direction: column;
  gap: var(--novel-sp-3);
  width: min(360px, 100%);
  padding: 10px;
  border: 0.5px solid var(--novel-border);
  border-radius: var(--novel-r-md);
  background: var(--novel-code-bg);
}
.novel-moyu-illust-preview img { display: block; max-width: 100%; max-height: 420px; margin: 0 auto; object-fit: contain; }
.novel-moyu-illust-foot { display: flex; align-items: center; justify-content: space-between; color: var(--novel-text-3); font-size: 11.5px; }

/* 运行中：深度求索 + 鲸尾（宿主 RunningStatus） */
.novel-moyu-running {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  margin-top: var(--novel-sp-4);
  color: var(--novel-deep-diving);
  font-size: var(--novel-fs-sm);
  line-height: 22px;
}
.novel-moyu-running-divider {
  position: absolute;
  top: -4px;
  right: 0;
  left: 0;
  height: 0.5px;
  background: color-mix(in srgb, var(--novel-border-faint) 75%, var(--novel-border));
  /* 默认不显；仅上一可见行是输出时淡入（宿主 ChatView 「.runningDivider」 口径）。 */
  opacity: 0;
  pointer-events: none;
}
.novel-moyu-running[data-has-output] .novel-moyu-running-divider { opacity: 1; }
@media (prefers-reduced-motion: no-preference) {
  .novel-moyu-running-divider { transition: opacity 160ms ease; }
}
.novel-moyu-running-content { display: inline-flex; align-items: center; gap: var(--novel-sp-2); height: 28px; margin-top: var(--novel-sp-1); }
.novel-moyu-running-icon { display: inline-flex; flex: none; width: 14px; height: 14px; }
.novel-moyu-running-icon svg { width: 14px; height: 14px; }
.novel-moyu-running-text { font-variant-numeric: tabular-nums; }
.novel-moyu-running-text.is-shimmer {
  color: transparent;
  background: linear-gradient(105deg, var(--novel-deep-diving) 0%, var(--novel-deep-diving) 38%,
    var(--novel-shimmer) 50%, var(--novel-deep-diving) 62%, var(--novel-deep-diving) 100%);
  background-clip: text;
  -webkit-background-clip: text;
  background-size: 220% 100%;
  animation: novel-moyu-text-shimmer 1.5s linear infinite;
}

/* 错误行（宿主 MessageItem 「.turnErrorRow」：start 对齐、2px 内边距、secondary 13/20） */
.novel-moyu-error-row {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto;
  gap: var(--novel-sp-3);
  align-items: start;
  margin-top: 5px;
  padding: 2px 0;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.novel-moyu-error-dot { width: 8px; height: 8px; border-radius: 50%; corner-shape: round; background: var(--novel-err); }
.novel-moyu-error-copy { min-width: 0; overflow-wrap: anywhere; }
.novel-moyu-error-title { margin-right: var(--novel-sp-2); color: var(--novel-err); font-weight: 600; }
.novel-moyu-error-msg { color: var(--novel-text-2); }
/* M4：错误码芯片（宿主 turnErrorRow 第三列 <code>：markdown code 小字号、tertiary）。 */
.novel-moyu-error-code {
  color: var(--novel-text-3);
  font-family: var(--novel-font-mono);
  font-size: var(--novel-fs-sm);
  line-height: 18px;
}

/* 轮尾动作（宿主 TurnTailNodeView + MessageIconActions） */
.novel-moyu-tail-actions {
  display: flex;
  align-items: center;
  gap: var(--novel-sp-1);
  height: 28px;
  margin-top: var(--novel-sp-5);
  margin-left: -6px;
  color: var(--novel-text-3);
}
.novel-moyu-msg-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 6px;
  border: none;
  border-radius: var(--novel-r-md);
  background: transparent;
  color: var(--novel-text-3);
}
@media (hover: hover) {
  .novel-moyu-msg-action:hover:not(:disabled) { background: var(--novel-hover); color: var(--novel-text-2); }
}
.novel-moyu-msg-action:disabled { opacity: .4; }
.novel-moyu-msg-action svg { width: 15px; height: 15px; flex: none; }
/* 轮尾动作图标比用户行大一档（宿主 MessageIconActions：end 17 / user 15）。 */
.novel-moyu-tail-actions .novel-moyu-msg-action svg { width: 17px; height: 17px; }
/* 轮尾尾注（M1）：用量胶囊 + 消息时刻（宿主 MessageIconActions 的 endInfo：
   信息字号 12px、8px 聚簇、8px 左外距；用量胶囊取 TurnUsagePanel 触发器形制）。 */
.novel-moyu-tail-info {
  display: inline-flex;
  align-items: center;
  gap: var(--novel-sp-3);
  min-width: 0;
  margin-left: var(--novel-sp-3);
  color: var(--novel-text-3);
  font-size: var(--novel-fs-sm);
  line-height: 24px;
  font-variant-numeric: tabular-nums;
}
.novel-moyu-tail-usage {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--novel-r-sm);
  color: var(--novel-text-3);
  font-size: var(--novel-fs-sm);
  white-space: nowrap;
}
.novel-moyu-tail-time { white-space: nowrap; }

/* ── 真轮次镜像（中性占位行：未映射节点 / 降级轮的如实降级，不编语义）。 ── */
.novel-moyu-mirror-skip {
  padding: 4px 0;
  color: var(--novel-text-3);
  font-size: var(--novel-fs-sm);
  line-height: 20px;
}
/* 统计坞两枚 pill 的分隔字形（宿主 StatsPills .sep）。 */
.novel-moyu-stat-sep { color: var(--novel-caption); }

/* 回到底部：吸底圆钮（宿主 ChatView） */
.novel-moyu-to-bottom-slot {
  position: sticky;
  bottom: calc(136px + 16px);
  z-index: 8;
  display: flex;
  justify-content: flex-end;
  height: 0;
  padding-right: max(
    calc(var(--novel-moyu-clearance) + 16px),
    calc((100% - var(--novel-moyu-column-w)) / 2)
  );
  pointer-events: none;
}
.novel-moyu-to-bottom {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  margin-top: -34px;
  padding: 0;
  border: 0.5px solid var(--novel-border-mid);
  border-radius: 100px;
  corner-shape: round;
  background: var(--novel-float);
  color: var(--novel-text);
  box-shadow: var(--novel-shadow-2);
  pointer-events: auto;
}
.novel-moyu-to-bottom:hover { background: var(--novel-hover-solid); }
.novel-moyu-to-bottom svg { width: 16px; height: 16px; }

/* ═══ 吸底输入座（宿主 InputBar） ═══════════════════════════════════════ */
.novel-moyu-composer-seat {
  position: sticky;
  bottom: 0;
  z-index: 9;
  margin-top: auto;
  /* 宿主 composerStack 的 6px 节奏（输入座不自带顶距）。 */
  padding-top: 6px;
  overflow-anchor: none;
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--novel-bg) 0%, transparent) 0px,
    var(--novel-bg) 36px);
}
.novel-moyu-composer-root {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 var(--novel-moyu-clearance) 4px;
}
.novel-moyu-composer-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--novel-sp-4);
  width: 100%;
  max-width: calc(var(--novel-moyu-column-w) + 32px);
  padding-top: var(--novel-sp-3);
  border: 0;
  border-radius: var(--novel-r-panel);
  background: var(--novel-input-fill);
  /* 宿主输入卡的 elevation-soft：0.5px 发丝描边（l2 间接色）+ 柔光两层。 */
  --novel-elevation-stroke-color: var(--novel-border);
  box-shadow: var(--novel-elevation-soft);
  /* 草稿字号跟宿主「字号」设置；行距随 px delta 联动。 */
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
}
/* 草稿滚动面（抬升面：滚动条取 l2 对，宿主 .card 的同款重绑）。 */
.novel-moyu-composer-card {
  --novel-scrollbar: var(--novel-scrollbar-elevated);
  --novel-scrollbar-hover: var(--novel-scrollbar-elevated-hover);
}
.novel-moyu-composer-scroll { max-height: 336px; margin-right: var(--novel-sp-1); overflow-y: auto; }
.novel-moyu-composer-scroll::-webkit-scrollbar-track { margin-top: 8px; }
.novel-moyu-input {
  display: block;
  width: 100%;
  min-height: 36px;
  padding: 4px 8px 0 14px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--novel-text);
  caret-color: var(--novel-business);
  font-family: var(--novel-font-text);
  font-size: inherit;
  line-height: inherit;
  resize: none;
}
.novel-moyu-input::placeholder { color: var(--novel-caption); }
.novel-moyu-composer-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--novel-sp-4);
  min-width: 0;
  padding: 2px 8px 6px;
  /* 宿主 .row 的行宽容器：chip 收窄机制按行宽裁（control-row-layout）。 */
  container-type: inline-size;
}
.novel-moyu-composer-tools { display: flex; align-items: center; gap: var(--novel-sp-4); min-width: 0; }
.novel-moyu-composer-add {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 999px;
  corner-shape: round;
  background: var(--novel-selector-fill);
  color: var(--novel-text);
}
@media (hover: hover) {
  .novel-moyu-composer-add:hover:not(:disabled) { background: var(--novel-hover-solid); }
}
.novel-moyu-composer-add:disabled { opacity: .5; }
.novel-moyu-composer-add svg { width: 14px; height: 14px; }
/* 宿主 .select 的 chip 形态（权限/计划 select 的同款闭合态）：28px、13/20/500、
   12px caption 色 chevron 贴右 4px、padding 0 20px 0 8px、max-width 220。 */
.novel-moyu-select {
  position: relative;
  display: inline-flex;
  align-items: center;
  max-width: 220px;
  height: 28px;
  padding: 0 20px 0 8px;
  border: none;
  border-radius: var(--novel-r-sm);
  background-color: transparent;
  color: var(--novel-text-2);
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}
.novel-moyu-select::after {
  content: '';
  position: absolute;
  right: 4px;
  top: 50%;
  width: 12px;
  height: 12px;
  transform: translateY(-50%);
  background: var(--novel-caption);
  /* chevron 背景图的同形画法：mask 上色跟随 caption（宿主 data-URI 写死色值，这里不进字面量）。 */
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat center / 12px 12px;
}
@media (hover: hover) {
  .novel-moyu-select:hover:not(:disabled) { background-color: var(--novel-hover); }
}
.novel-moyu-select:disabled { opacity: .5; cursor: default; }
/* 控制行的 select 空位（拍板已定将来放「工作区 chip」）：座位先留住，形态用上面的 .select。 */
.novel-moyu-select-seat:empty { display: none; }
/* 模型 chip（宿主 ModelSelect 触发器形态：模型名 + effort 小字 + 12px caption chevron）。 */
.novel-moyu-model-chip {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: baseline;
  gap: 4px;
  max-width: 360px;
  height: 28px;
  padding: 0 20px 0 8px;
  border: none;
  border-radius: var(--novel-r-sm);
  background: transparent;
  color: var(--novel-text-2);
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
}
.novel-moyu-model-chip .novel-moyu-model-name {
  min-width: 0;
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
}
.novel-moyu-model-chip .novel-moyu-model-effort {
  flex: none;
  color: var(--novel-caption);
  font-size: 11px;
}
.novel-moyu-model-chip::after {
  content: '';
  position: absolute;
  right: 4px;
  top: 50%;
  width: 12px;
  height: 12px;
  transform: translateY(-50%);
  background: var(--novel-caption);
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat center / 12px 12px;
}
@media (hover: hover) {
  .novel-moyu-model-chip:hover { background-color: var(--novel-hover); }
}
.novel-moyu-composer-trailing { display: flex; flex: none; align-items: center; gap: 12px; margin-left: auto; }
.novel-moyu-send {
  display: grid;
  flex: none;
  place-items: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 999px;
  corner-shape: round;
  background: var(--novel-info-fill);
  color: var(--novel-on-solid);
  transform: translateY(-2px);
  transition: background-color 100ms ease;
}
.novel-moyu-send:hover:not(:disabled) { background: var(--novel-info-hover); }
.novel-moyu-send:disabled { opacity: .4; }
.novel-moyu-send svg { width: 16px; height: 16px; }
.novel-moyu-composer-dock {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--novel-sp-4);
  min-height: 22px;
  max-width: 100%;
  padding-top: var(--novel-sp-1);
}
.novel-moyu-stat-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--novel-sp-2);
  padding: 1px 8px;
  border: none;
  border-radius: var(--novel-r-md);
  background: transparent;
  color: var(--novel-text-3);
  font-size: var(--novel-fs-sm);
  line-height: 20px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.novel-moyu-stat-pill svg { width: 14px; height: 14px; flex: none; }
/* ContextMeter 触发器读数比 pill 大一档（宿主 pill 12 / ContextMeter 13）。 */
.novel-moyu-context-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--novel-sp-2);
  padding: 1px 8px;
  border: none;
  border-radius: var(--novel-r-sm);
  background: transparent;
  color: var(--novel-text-3);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 20px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
}
.novel-moyu-context-pill:hover { background: var(--novel-hover); }
.novel-moyu-context-pill svg { width: 14px; height: 14px; flex: none; }
.novel-moyu-context-track { fill: none; stroke: var(--novel-border-mid); stroke-width: 2; }
.novel-moyu-context-fill { fill: none; stroke: var(--novel-text-3); stroke-width: 2; stroke-linecap: round; }

/* 听书任务条（I13+I14）：QueueDock 的衣服——16px 圆角、menu 材质 + blur(40) 毛玻璃、
   13px 文、36px 行、行间发丝线、28px 圆钮、预览行 ellipsis（宿主队列条口径）。 */
.novel-moyu-queue-dock {
  position: relative;
  width: calc(100% - var(--novel-moyu-clearance) - var(--novel-moyu-clearance) - 16px);
  max-width: calc(calc(var(--novel-moyu-column-w) + 32px) - 16px);
  margin: 0 auto -6px;
}
.novel-moyu-queue-panel {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  width: 100%;
  padding: 2px 0;
  border-radius: var(--novel-r-lg) var(--novel-r-lg) 0 0;
}
.novel-moyu-queue-panel::before {
  position: absolute;
  z-index: -1;
  inset: 0;
  border-radius: inherit;
  background: var(--novel-menu-fill);
  backdrop-filter: var(--novel-menu-blur);
  content: '';
  pointer-events: none;
}
.novel-moyu-queue-panel::after {
  position: absolute;
  inset: 0;
  border: 0.5px solid var(--novel-border-faint);
  border-bottom: none;
  border-radius: inherit;
  content: '';
  pointer-events: none;
}
.novel-moyu-queue-row {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  padding: 4px 12px;
}
/* 行间发丝线（宿主 .row + .row 的 inset 顶线）。 */
.novel-moyu-queue-row + .novel-moyu-queue-row,
.novel-moyu-queue-row + .novel-moyu-queue-fail,
.novel-moyu-queue-row + .novel-moyu-queue-seek,
.novel-moyu-queue-fail + .novel-moyu-queue-seek { box-shadow: inset 0 1px 0 var(--novel-border-faint); }
.novel-moyu-queue-lead {
  display: grid;
  flex: none;
  place-items: center;
  width: 16px;
  height: 16px;
  color: var(--novel-text-3);
}
.novel-moyu-queue-lead svg { width: 14px; height: 14px; }
.novel-moyu-queue-label {
  flex: none;
  min-width: 0;
  overflow: hidden;
  color: var(--novel-text-2);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 24px;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 当前段一行预览：长句 ellipsis（宿主 .preview 的单行收口）。 */
.novel-moyu-queue-preview {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--novel-text-3);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.novel-moyu-queue-controls { display: flex; align-items: center; gap: var(--novel-sp-1); }
/* 28px 圆钮（宿主 QueueDock .action：999px + corner-shape round，hover 只加底）。 */
.novel-moyu-queue-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border: none;
  border-radius: 999px;
  corner-shape: round;
  background: transparent;
  color: var(--novel-text-2);
  font-size: var(--novel-fs-sm);
  line-height: 1;
  cursor: pointer;
}
@media (hover: hover) {
  .novel-moyu-queue-btn:hover:not(:disabled) { background: var(--novel-hover); }
}
.novel-moyu-queue-btn.is-on { background: var(--novel-hover); color: var(--novel-text); }
.novel-moyu-queue-btn:disabled { opacity: .4; }
.novel-moyu-queue-btn svg { width: 14px; height: 14px; flex: none; }
.novel-moyu-queue-fail { padding: 2px 12px 4px; color: var(--novel-err); font-size: var(--novel-fs-sm); line-height: 18px; }
.novel-moyu-queue-seek {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 28px;
  padding: 2px 12px 6px;
}
.novel-moyu-queue-seek .novel-tts-range { flex: 1 1 auto; width: 100%; }
.novel-moyu-mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--novel-r-md);
  background: transparent;
  color: var(--novel-text-2);
  font-size: var(--novel-fs-sm);
}
.novel-moyu-mini-btn:hover { background: var(--novel-hover); color: var(--novel-text); }
.novel-moyu-mini-btn svg { width: 14px; height: 14px; }

/* ═══ 轨迹台账（T1–T5）：工具栏 + sticky 轮次头 + 事件表 + 事件详情浮层
   （形态照宿主轨迹面板的工具栏 / 轮次头 /
   TrajectoryCell + TrajectoryTable / 事件详情概述）。 ═══════════════════════════════ */
.novel-moyu-traj {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: var(--novel-moyu-column-w);
  margin: 0 auto;
  padding-bottom: 24px;
}
.novel-moyu-traj-toolbar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 12px;
  box-sizing: border-box;
  height: 44px;
  padding: 0 16px;
  border-bottom: 0.5px solid var(--novel-border);
  background: var(--novel-bg);
}
.novel-moyu-traj-action {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: var(--novel-r-sm);
  background: transparent;
  color: var(--novel-text-2);
  font-size: var(--novel-fs-sm);
  cursor: pointer;
}
@media (hover: hover) {
  .novel-moyu-traj-action:hover { background: var(--novel-hover); color: var(--novel-text); }
}
.novel-moyu-traj-action-icon { flex: none; width: 14px; text-align: center; line-height: 1; }
.novel-moyu-traj-search {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  height: 28px;
  padding: 0 8px;
  border: 0.5px solid var(--novel-border-strong);
  border-radius: var(--novel-r-md);
  background: var(--novel-layer-1);
}
.novel-moyu-traj-search:focus-within { border-color: var(--novel-business); }
.novel-moyu-traj-search-icon { display: inline-flex; width: 14px; height: 14px; color: var(--novel-text-3); }
.novel-moyu-traj-search-icon svg { width: 14px; height: 14px; }
.novel-moyu-traj-search-input {
  width: 160px;
  min-width: 0;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--novel-text);
  font: inherit;
  font-size: var(--novel-fs-sm);
}
.novel-moyu-traj-search-input::placeholder { color: var(--novel-caption); }
.novel-moyu-traj-search-input::-webkit-search-cancel-button { display: none; }
.novel-moyu-traj-table { display: flex; flex-direction: column; }
.novel-moyu-traj-turn-head {
  position: sticky;
  top: 44px;
  z-index: 1;
  box-sizing: border-box;
  width: 100%;
  height: 44px;
  background: var(--novel-ghost-fill);
}
.novel-moyu-traj-turn-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 0 16px;
}
.novel-moyu-traj-turn-title {
  flex: none;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--novel-text);
  font-size: var(--novel-fs-md);
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
/* 四列指标头（宿主 TrajectoryTurnHeader：4×71 + 3×12 = 320px 列道 + 8px 右余量）。 */
.novel-moyu-traj-columns {
  flex: none;
  display: flex;
  align-items: center;
  width: 320px;
  gap: 12px;
  margin-right: 8px;
}
.novel-moyu-traj-column {
  flex: none;
  width: 71px;
  color: var(--novel-text-2);
  font-size: var(--novel-fs-md);
  text-align: left;
}
/* 事件行（宿主 TrajectoryTable 口径：30px 表格行 + 0.5px l1 发丝 + hover/选中两态）。 */
.novel-moyu-traj-row {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  gap: 24px;
  width: 100%;
  height: 30px;
  padding: 0 8px 0 20px;
  border: 0;
  border-bottom: 0.5px solid var(--novel-border-faint);
  background: transparent;
  color: var(--novel-text);
  font-size: var(--novel-fs-md);
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) {
  .novel-moyu-traj-row:hover { background: var(--novel-hover); }
}
.novel-moyu-traj-row[data-selected='true'] { background: var(--novel-active); }
.novel-moyu-traj-row:focus-visible { outline: none; box-shadow: inset 0 0 0 1px var(--novel-ring); }
.novel-moyu-traj-index {
  flex: none;
  width: 24px;
  color: var(--novel-text-3);
  font-size: var(--novel-fs-md);
}
.novel-moyu-traj-tag-slot { flex: none; display: flex; align-items: center; width: 80px; min-width: 0; }
.novel-moyu-traj-tag {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  height: 22px;
  max-width: 100%;
  padding: 0 4px;
  border-radius: var(--novel-r-xs);
  font-size: var(--novel-fs-md);
  font-weight: 600;
  white-space: nowrap;
}
.novel-moyu-traj-tag.is-user { color: var(--novel-tag-user-fg); background: var(--novel-tag-user-bg); }
.novel-moyu-traj-tag.is-tool { color: var(--novel-tag-tool-fg); background: var(--novel-tag-tool-bg); }
.novel-moyu-traj-tag.is-message { color: var(--novel-tag-msg-fg); background: var(--novel-tag-msg-bg); }
.novel-moyu-traj-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--novel-text);
  font-size: var(--novel-fs-md);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.novel-moyu-traj-trailing {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: 320px;
  min-width: 0;
  gap: 12px;
}
.novel-moyu-traj-metric {
  flex: none;
  width: 71px;
  overflow: hidden;
  color: var(--novel-text-3);
  font-size: var(--novel-fs-md);
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 事件详情浮层（宿主「事件详情」概述排版：42px 头 + 94px 标签列的 dl 键值行）。 */
.novel-moyu-traj-detail {
  position: absolute;
  top: calc(var(--novel-moyu-topbar-h) + 44px);
  right: calc(var(--novel-moyu-dock-w) + 8px);
  bottom: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(320px, calc(100% - 24px));
  border-left: 0.5px solid var(--novel-border);
  background: var(--novel-layer-1);
  box-shadow: var(--novel-shadow-2);
}
.novel-moyu-stage:not(.has-dock) .novel-moyu-traj-detail { right: 0; }
.novel-moyu-traj-detail-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  height: 42px;
  padding: 0 8px 0 12px;
  border-bottom: 0.5px solid var(--novel-border);
}
.novel-moyu-traj-detail-title { color: var(--novel-text); font-size: var(--novel-fs-md); font-weight: 500; }
.novel-moyu-traj-detail-close {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--novel-r-sm);
  background: transparent;
  color: var(--novel-text-2);
  cursor: pointer;
}
@media (hover: hover) {
  .novel-moyu-traj-detail-close:hover { background: var(--novel-hover); color: var(--novel-text); }
}
.novel-moyu-traj-detail-close svg { width: 14px; height: 14px; }
.novel-moyu-traj-detail-rows {
  margin: 0;
  padding: 8px 0;
  font-size: var(--novel-fs-md);
}
.novel-moyu-traj-detail-rows > div {
  display: grid;
  grid-template-columns: 94px minmax(0, 1fr);
  align-items: center;
  min-height: 22px;
  padding: 0 14px;
}
.novel-moyu-traj-detail-rows dt { color: var(--novel-text-3); }
.novel-moyu-traj-detail-rows dd {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--novel-text);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.novel-moyu-traj-detail-open {
  flex: none;
  box-sizing: border-box;
  height: 28px;
  margin: 8px 14px;
  padding: 0 10px;
  border: 0.5px solid var(--novel-border-mid);
  border-radius: var(--novel-r-sm);
  background: transparent;
  color: var(--novel-text-2);
  font-size: var(--novel-fs-sm);
  cursor: pointer;
}
@media (hover: hover) {
  .novel-moyu-traj-detail-open:hover { background: var(--novel-hover); color: var(--novel-text); }
}

/* ═══ 文件坞：宽可拖（D9，38px 标签条 + 38px 文件头 + 树/预览） ═══════════ */
/* D9 坞宽分隔条（照 FileNavigator separator 口径）：8px 热区骑在坞左规上，
   col-resize + ←/→/Home/End（step 20），宽度记 localStorage（值槽 --novel-moyu-dock-w）。 */
.novel-moyu-dock-sep {
  position: relative;
  flex: none;
  width: 8px;
  height: 100%;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
}
@media (hover: hover) {
  .novel-moyu-dock-sep::after {
    position: absolute;
    inset: 0;
    background: linear-gradient(to bottom, transparent, var(--novel-caption) 50%, transparent) center / 1px 100% no-repeat;
    opacity: 0;
    content: '';
    transition: opacity 120ms ease-out;
  }
  .novel-moyu-dock-sep:hover::after { opacity: 1; }
}
.novel-moyu-dock-sep:focus-visible { outline: 2px solid var(--novel-ring); outline-offset: -2px; }
.novel-moyu-dock {
  display: flex;
  flex: none;
  flex-direction: column;
  width: var(--novel-moyu-dock-w);
  height: 100%;
  border-left: 0.5px solid var(--novel-border-strong);
  background: var(--novel-bg);
  user-select: none;
}
.novel-moyu-dock-strip {
  display: flex;
  flex: none;
  gap: 4px;
  align-items: center;
  height: 38px;
  padding: 10px 6px 0 10px;
}
/* tab chip（宿主 dockkit 「_tab/_tabTitle/_tabClose」：min/max 80/170、28px、radius-sm、
   字重 400、超长渐隐、每枚自带 20px ×（hover/激活/聚焦才现））。 */
.novel-moyu-dock-tab {
  position: relative;
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  min-width: 80px;
  max-width: 170px;
  height: 28px;
  border-radius: var(--novel-r-sm);
  background: transparent;
}
.novel-moyu-dock-tab.is-on { background: var(--novel-tab-active); }
.novel-moyu-dock-tab-main {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 5px;
  min-width: 0;
  height: 100%;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: var(--novel-text-2);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  font-weight: 400;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}
.novel-moyu-dock-tab.is-on .novel-moyu-dock-tab-main { color: var(--novel-text); }
.novel-moyu-dock-tab-title {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  line-height: 1.4;
  mask-image: linear-gradient(to right, black calc(100% - 16px), transparent);
}
/* 激活 / 悬停 / 聚焦时右侧给 × 让位的渐隐（宿主 dockkit tabTitle 的双段 mask）。 */
.novel-moyu-dock-tab.is-on .novel-moyu-dock-tab-title,
.novel-moyu-dock-tab:focus-within .novel-moyu-dock-tab-title {
  mask-image: linear-gradient(to right, black calc(100% - 30px), transparent calc(100% - 14px));
}
@media (hover: hover) {
  .novel-moyu-dock-tab:hover .novel-moyu-dock-tab-title {
    mask-image: linear-gradient(to right, black calc(100% - 30px), transparent calc(100% - 14px));
  }
}
.novel-moyu-dock-tab-main svg { width: 16px; height: 16px; flex: none; }
/* tab chip 的文件牌图标：FileTypeIcon folder 的琥珀色相。 */
.novel-moyu-dock-tab-icon { flex: none; width: 16px; height: 16px; color: var(--novel-file-folder); }
.novel-moyu-dock-tab-icon svg { width: 16px; height: 16px; }
/* chip 的 ×：20px、hover/激活/聚焦才现（宿主 dockkit _tabClose）。 */
.novel-moyu-dock-tab-close {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--novel-r-sm);
  background: transparent;
  color: var(--novel-text-3);
  opacity: 0;
  pointer-events: none;
  cursor: pointer;
}
.novel-moyu-dock-tab.is-on .novel-moyu-dock-tab-close,
.novel-moyu-dock-tab:focus-within .novel-moyu-dock-tab-close {
  opacity: 1;
  pointer-events: auto;
}
@media (hover: hover) {
  .novel-moyu-dock-tab:hover .novel-moyu-dock-tab-close { opacity: 1; pointer-events: auto; }
  .novel-moyu-dock-tab-close:hover { background: var(--novel-hover); color: var(--novel-text); }
}
.novel-moyu-dock-tab-close svg { width: 12px; height: 12px; }
.novel-moyu-dock-strip-fill { flex: 1 1 0; min-width: 0; }
/* 右端 chrome：＋（addTab）→ fill → 全屏 → 收起（宿主 ui-dockkit strip 的 DOM 序）。 */
.novel-moyu-dock-strip-chrome { display: flex; flex: none; gap: 8px; align-items: center; height: 28px; margin-left: 4px; }
.novel-moyu-dock-addtab {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--novel-r-sm);
  background: transparent;
  color: var(--novel-text-2);
  cursor: pointer;
}
@media (hover: hover) {
  .novel-moyu-dock-addtab:hover { background: var(--novel-hover); color: var(--novel-text); }
}
.novel-moyu-dock-addtab svg { width: 15px; height: 15px; }
/* 文件头 38px：PathLabel 根路径 + 重新读取 / 搜索 / 在应用中打开。 */
.novel-moyu-files-header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  height: 38px;
  padding: 0 6px 0 16px;
  border-bottom: 0.5px solid var(--novel-border-mid);
  color: var(--novel-text-2);
  font-size: var(--dsh-content-font-size-secondary, 13px);
}
/* PathLabel：目录段三级色 + 末段主色，左缘 28px 渐隐；悬停出整路径 tooltip。 */
.novel-moyu-path {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 0;
  min-width: 0;
  margin-right: 12px;
  overflow: hidden;
  font-family: var(--novel-font-mono);
  font-size: var(--novel-fs-sm);
  white-space: nowrap;
  mask-image: linear-gradient(to right, transparent 0, black 28px);
}
.novel-moyu-path-seg { color: var(--novel-text-3); }
.novel-moyu-path-seg.is-file { color: var(--novel-text); }
.novel-moyu-files-actions { display: flex; flex: none; align-items: center; gap: 4px; }
/* 搜索条（宿主 FilesBody 「.searchBar」 42px + Input 形制的整框）。 */
.novel-moyu-files-search {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
  box-sizing: border-box;
  height: 42px;
  padding: 8px 8px 4px;
}
.novel-moyu-files-search-field {
  display: flex;
  flex: 1 1 auto;
  gap: 2px;
  align-items: center;
  box-sizing: border-box;
  min-width: 0;
  height: 100%;
  padding: 0 2px;
  border: 0.5px solid var(--novel-border-strong);
  border-radius: var(--novel-r-md);
  background: var(--novel-layer-1);
}
.novel-moyu-files-search-field:focus-within { border-color: var(--novel-business); }
.novel-moyu-files-search-field .novel-moyu-tool { width: 24px; height: 24px; padding: 4px; }
.novel-moyu-files-search-field .novel-moyu-tool svg { width: 14px; height: 14px; }
.novel-moyu-files-search input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0 4px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--novel-text);
  font: inherit;
}
.novel-moyu-files-search input::placeholder { color: var(--novel-caption); }
.novel-moyu-files-search input::-webkit-search-cancel-button { display: none; }
.novel-moyu-files-clear {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--novel-text-3);
}
.novel-moyu-files-clear svg { width: 12px; height: 12px; }
/* 计数行（宿主 「.searchStatus」：12px tertiary、2px 18px 顶内边距）。 */
.novel-moyu-search-status {
  display: flex;
  flex: none;
  gap: 6px;
  align-items: center;
  min-height: 18px;
  margin: 0;
  padding: 2px 18px 0;
  color: var(--novel-text-3);
  font-size: var(--novel-fs-sm);
}
.novel-moyu-search-status:empty { min-height: 0; padding: 0; }
.novel-moyu-search-status-line { display: block; min-width: 0; }
/* 全屏切换钮（宿主 dockkit fullscreen 模式）：坞盖满整个主区。 */
.novel-moyu-stage.is-dock-fullscreen .novel-moyu-dock {
  position: absolute;
  inset: 0;
  z-index: calc(var(--novel-z-modal) - 2);
  width: auto;
  border-left: 0;
}
.novel-moyu-files-tree {
  flex: 1 1 auto;
  min-height: 0;
  /* 宿主树体：右侧 2px 滚动条让位 + 稳定槽；条距边 2px。 */
  margin-right: 2px;
  padding: 8px 0 8px 8px;
  overflow-y: auto;
  scrollbar-gutter: stable;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 1.5;
}
.novel-moyu-files-tree::-webkit-scrollbar-track { margin: 2px; }
.novel-moyu-tree-level { margin: 0; padding: 0; list-style: none; }
.novel-moyu-tree-level .novel-moyu-tree-level { padding-left: 18px; }
.novel-moyu-tree-item { margin: 0; padding: 0; }
.novel-moyu-tree-row {
  display: flex;
  align-items: center;
  width: 100%;
  border-radius: var(--novel-r-md);
}
@media (hover: hover) {
  .novel-moyu-tree-row:hover { background: var(--novel-hover); }
  .novel-moyu-tree-row.is-current:hover { background: var(--novel-active); }
}
.novel-moyu-tree-row.is-current { background: var(--novel-active); }
.novel-moyu-tree-action {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--novel-sp-2);
  min-width: 0;
  padding: 5px 10px;
  border: 0;
  border-radius: var(--novel-r-md);
  background: transparent;
  color: var(--novel-text);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  text-align: left;
}
.novel-moyu-tree-folder, .novel-moyu-tree-file { flex: none; width: 16px; height: 16px; }
.novel-moyu-tree-folder svg, .novel-moyu-tree-file svg { width: 16px; height: 16px; }
.novel-moyu-tree-folder { color: var(--novel-text-3); }
.novel-moyu-tree-file.md { color: var(--novel-text-3); }
.novel-moyu-tree-file.ts { color: var(--novel-business); }
.novel-moyu-tree-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.novel-moyu-tree-name mark { color: var(--novel-business); background: transparent; }
/* 「已访问」状态点（宿主 StateDot 词汇的降调态）：4px、半透明次要色，屏幕外说明走 aria。 */
.novel-moyu-tree-dot {
  flex: none;
  width: 4px;
  height: 4px;
  margin-right: 10px;
  border-radius: 50%;
  corner-shape: round;
  background: color-mix(in srgb, var(--novel-text-2) 45%, transparent);
}

/* ═══ 菜单面（宿主菜单面口径：无圆角、4px 内边距、min 144、elevation-prominent）══ */
.novel-moyu-menu-wrap { position: relative; display: inline-flex; }
.novel-moyu-menu-surface {
  position: fixed;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: min(144px, calc(100vw - 24px));
  max-width: min(360px, calc(100vw - 24px));
  padding: 4px;
  border: 0;
  background: var(--novel-menu-fill);
  backdrop-filter: var(--novel-menu-blur);
  --novel-elevation-stroke-color: var(--novel-border-faint);
  box-shadow: var(--novel-elevation-prominent);
  --novel-scrollbar: var(--novel-scrollbar-elevated);
  --novel-scrollbar-hover: var(--novel-scrollbar-elevated-hover);
}
.novel-moyu-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--novel-r-md);
  background: transparent;
  color: var(--novel-text);
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) {
  .novel-moyu-menu-item:hover { background: var(--novel-hover); }
}
/* 方向键游走焦点（宿主 Menu autoFocus 语义）：焦点即选中底。 */
.novel-moyu-menu-item:focus-visible { outline: none; background: var(--novel-hover); }
.novel-moyu-menu-item-left { display: inline-flex; align-items: center; gap: var(--novel-sp-2); min-width: 0; }
.novel-moyu-menu-item-left svg { flex: none; width: 14px; height: 14px; color: var(--novel-text-2); }
.novel-moyu-menu-badge { color: var(--novel-text-3); font-family: var(--novel-font-mono); font-size: var(--novel-fs-xs); }
.novel-moyu-menu-sep { height: 0.5px; margin: 3px 8px; background: var(--novel-border); }
/* 菜单项 shortcut 字段：本构建的宿主隐藏该列，照此渲染（字段在、不上屏）。 */
.novel-moyu-menu-shortcut { display: none; }
.novel-moyu-menu-group {
  padding: 4px 8px 2px;
  color: var(--novel-text-3);
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
}

/* ═══ 文档预览 tab（D1+D2）：README 真 Markdown 渲染 + 章节真文本。
   排版照宿主文档预览的 Markdown 字阶与间距。 ═══ */
.novel-moyu-preview { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
.novel-moyu-preview-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  box-sizing: border-box;
  height: 38px;
  padding: 0 8px 0 16px;
  border-bottom: 0.5px solid var(--novel-border-mid);
}
.novel-moyu-preview-path {
  min-width: 0;
  overflow: hidden;
  color: var(--novel-text-2);
  font-family: var(--novel-font-mono);
  font-size: var(--novel-fs-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.novel-moyu-preview-open {
  flex: none;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--novel-border-mid);
  border-radius: var(--novel-r-sm);
  background: transparent;
  color: var(--novel-text-2);
  font-size: var(--novel-fs-sm);
  cursor: pointer;
}
@media (hover: hover) {
  .novel-moyu-preview-open:hover { background: var(--novel-hover); color: var(--novel-text); }
}
.novel-moyu-preview-body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 10px 12px;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
/* 章节真文本（M18 不做正文 markdown 渲染：这是伪装文件的原文上屏）。 */
.novel-moyu-preview-text {
  margin: 0;
  color: var(--novel-text);
  font-family: var(--novel-font-text);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  white-space: pre-wrap;
  word-break: break-word;
}
/* Markdown 排版口径（宿主 MarkdownText）：h1 21/30、h2 19/28、h3 18/26、h4 600 基字、
   段 16px 上下、行内码 0.875em l1 发丝芯片、引用 2px caption 左线、hr 0.5px l2。 */
.novel-moyu-md {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--novel-text);
  font-family: var(--novel-font-text);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
}
.novel-moyu-md-h1 { margin: 32px 0 16px; font-size: calc(21px + var(--dsh-content-font-delta, 0px)); line-height: calc(30px + var(--dsh-content-font-delta, 0px)); font-weight: 700; }
.novel-moyu-md-h2 { margin: 32px 0 16px; font-size: calc(19px + var(--dsh-content-font-delta, 0px)); line-height: calc(28px + var(--dsh-content-font-delta, 0px)); font-weight: 700; }
.novel-moyu-md-h3 { margin: 32px 0 16px; font-size: calc(18px + var(--dsh-content-font-delta, 0px)); line-height: calc(26px + var(--dsh-content-font-delta, 0px)); font-weight: 700; }
.novel-moyu-md-h4 { margin: 16px 0; font-size: inherit; line-height: calc(24px + var(--dsh-content-font-delta, 0px)); font-weight: 600; }
.novel-moyu-md-p { margin: 16px 0; }
.novel-moyu-md > :first-child { margin-top: 0; }
.novel-moyu-md > :last-child { margin-bottom: 0; }
.novel-moyu-md strong { font-weight: 600; }
.novel-moyu-md code {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  padding: 0 5px;
  border: 0.5px solid var(--novel-border-faint);
  border-radius: var(--novel-r-sm);
  background: var(--novel-inline-code);
  font-family: var(--novel-font-mono);
  font-size: .875em;
}
.novel-moyu-md-list { margin: 16px 0; padding-left: 18px; }
.novel-moyu-md-list li:not(:first-child) { margin-top: 6px; }
.novel-moyu-md-list li::marker { line-height: 24px; color: var(--novel-text-2); }
.novel-moyu-md-hr { display: block; height: 0.5px; margin: 32px 0; border: none; background: var(--novel-border); }
.novel-moyu-md-quote { margin: 16px 0 0; padding-left: 14px; border-left: 2px solid var(--novel-caption); }
.novel-moyu-md-pre {
  margin: 16px 0;
  padding: 16px;
  overflow: auto;
  border-radius: var(--novel-r-md);
  background: var(--novel-code-bg);
  font-family: var(--novel-font-mono);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-all;
}

/* ═══ 浮层：舞台内的遮罩与面板层 ════════════════════════════════════════ */
.novel-moyu-overlay-layer { position: absolute; inset: 0; pointer-events: none; }
.novel-moyu-overlay-layer > * { pointer-events: auto; }
.novel-moyu-overlay-mask { position: absolute; inset: 0; z-index: var(--novel-z-mask); background: var(--novel-mask); }

/* ═══ 摸鱼模式下的宿主色浮层（设置 / 导出 / 导入说明） ══════════════════
   阅读器自己的纸色面板是「纸面」语言；摸鱼时这三张面板要像宿主弹出的浮层：
   面板层 2 底、12px 圆角、发丝描边、11.5px 段标签与 316px 宽度。 */
.novel-prefs.novel-prefs-host {
  position: absolute;
  top: 64px;
  right: 20px;
  z-index: var(--novel-z-modal);
  display: flex;
  flex-direction: column;
  gap: var(--novel-sp-4);
  width: 316px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 96px);
  padding: 14px 16px;
  overflow-y: auto;
  overscroll-behavior: contain;
  color: var(--novel-text);
  background: var(--novel-layer-2);
  border: 0.5px solid var(--novel-border-mid);
  border-radius: var(--novel-r-lg);
  box-shadow: var(--novel-shadow-pop);
  backdrop-filter: none;
  animation: none;
}
.novel-prefs.novel-prefs-host > .novel-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 0 8px;
  border-bottom: 0.5px solid var(--novel-border);
  font-size: var(--novel-fs-md);
  font-weight: 600;
}
.novel-prefs-host .novel-panel-head-title { display: flex; align-items: baseline; gap: var(--novel-sp-2); font-size: var(--novel-fs-md); font-weight: 600; }
.novel-prefs-host .novel-panel-head-sub { color: var(--novel-text-3); font-size: var(--novel-fs-sm); font-weight: 400; }
.novel-prefs-host .novel-panel-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--novel-r-md);
  background: transparent;
  color: var(--novel-text-2);
}
.novel-prefs-host .novel-panel-close:hover { background: var(--novel-hover); color: var(--novel-text); }
.novel-prefs-host .novel-panel-close svg { width: 14px; height: 14px; }
.novel-prefs-host .novel-prefs-body { display: flex; flex-direction: column; gap: var(--novel-sp-4); padding: 0; }
.novel-prefs-host .novel-setting-section { display: flex; flex-direction: column; gap: 7px; padding: 0; border-top: 0; }
.novel-prefs-host .novel-setting-title { margin: 0; color: var(--novel-text-3); font-size: 11.5px; font-weight: 500; line-height: 1.4; }
.novel-prefs-host .novel-setting-sublabel { margin: 0; color: var(--novel-text-3); font-size: 11.5px; }
.novel-prefs-host .novel-rdr-seg {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 2px;
  padding: 3px;
  border: 0.5px solid var(--novel-border);
  border-radius: var(--novel-r-md);
  background: var(--novel-layer-1);
}
.novel-prefs-host .novel-rdr-seg-thumb, .novel-prefs-host .novel-rdr-seg-thumb::after { display: none; }
.novel-prefs-host .novel-rdr-seg button {
  padding: 5px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--novel-text-2);
  font-size: var(--novel-fs-sm);
  line-height: 1.5;
  white-space: nowrap;
}
.novel-prefs-host .novel-rdr-seg button:hover:not(.on) { color: var(--novel-text); }
.novel-prefs-host .novel-rdr-seg button.on {
  background: var(--novel-active);
  color: var(--novel-business);
  font-weight: 600;
}
.novel-prefs-host .novel-rdr-pills { display: flex; gap: var(--novel-sp-2); flex-wrap: wrap; }
.novel-prefs-host .novel-rdr-pill {
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--novel-border);
  border-radius: var(--novel-r-md);
  background: transparent;
  color: var(--novel-text-2);
  font-size: var(--novel-fs-sm);
}
.novel-prefs-host .novel-rdr-pill.on { border-color: var(--novel-business); color: var(--novel-business); background: var(--novel-active); }
.novel-prefs-host .novel-note-sm { color: var(--novel-text-3); font-size: 11.5px; line-height: 1.5; }
.novel-prefs-host .novel-export-body { display: flex; flex-direction: column; gap: var(--novel-sp-4); padding: 0; }
.novel-prefs-host .novel-range-pair { gap: var(--novel-sp-3); }
.novel-prefs-host .novel-export-field > span { color: var(--novel-text-2); font-size: var(--novel-fs-sm); }
.novel-prefs-host .novel-export-field input {
  height: 28px;
  padding: 0 8px;
  border: 0.5px solid var(--novel-border-mid);
  border-radius: 6px;
  background: var(--novel-layer-1);
  color: var(--novel-text);
  font-family: var(--novel-font-mono);
  font-size: var(--novel-fs-sm);
}
.novel-prefs-host .novel-export-actions { display: flex; justify-content: flex-end; gap: var(--novel-sp-2); }
.novel-prefs-host .novel-btn {
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--novel-r-md);
  background: transparent;
  color: var(--novel-text-2);
  font-size: 12.5px;
  font-weight: 500;
}
.novel-prefs-host .novel-btn:hover { background: var(--novel-hover); }
.novel-prefs-host .novel-btn.primary { background: var(--novel-info-fill); color: var(--novel-on-solid); }
.novel-prefs-host .novel-btn.primary:hover { background: var(--novel-info-hover); }
.novel-prefs-host .novel-export-meta { color: var(--novel-text-3); font-size: var(--novel-fs-sm); }
.novel-prefs-host .novel-export-bar { background: var(--novel-code-bg); }
.novel-prefs-host .novel-export-bar i { background: var(--novel-business); }
.novel-prefs-host.novel-notes-slot {
  position: absolute;
  top: 50%;
  left: 50%;
  right: auto;
  width: auto;
  height: auto;
  transform: translate(-50%, -50%);
  z-index: var(--novel-z-modal);
  padding: 0;
  background: transparent;
  border: 0;
  box-shadow: none;
  backdrop-filter: none;
  animation: none;
}
.novel-prefs-host .novel-notes {
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100vh - 96px);
  overflow: auto;
  border: 0.5px solid var(--novel-border-mid);
  border-radius: var(--novel-r-lg);
  background: var(--novel-layer-2);
  box-shadow: var(--novel-shadow-pop);
}
.novel-prefs-host .novel-notes-head { padding: 12px 16px; border-bottom: 0.5px solid var(--novel-border); }
.novel-prefs-host .novel-notes-title { color: var(--novel-text); font-size: var(--novel-fs-md); font-weight: 600; }
.novel-prefs-host .novel-notes-body { padding: 12px 16px; }

/* ═══ 窄屏（宿主 FULLSCREEN_QUERY：width < 768px）：坞整栏全屏覆盖；头只归零 tabs 左内边距 ═══ */
@media (width < 768px) {
  .novel-moyu-tabs-row { padding-left: 0; }
  .novel-moyu-flow-wrap { padding: 16px 16px 24px; }
  .novel-moyu-composer-root { padding: 0 8px 4px; }
  .novel-moyu-dock {
    position: absolute;
    inset: 0;
    z-index: calc(var(--novel-z-modal) - 2);
    width: auto;
    border-left: 0;
  }
  .novel-moyu-to-bottom-slot { padding-right: 16px; }
  .novel-moyu-queue-label { max-width: 40vw; }
}
/* ═══ Tooltip 气泡（宿主 Tooltip 形态；手工 portal 挂舞台根）══════════ */
.novel-moyu-tooltip {
  position: fixed;
  z-index: 100;
  display: inline-flex;
  align-items: safe center;
  gap: 8px;
  width: max-content;
  box-sizing: border-box;
  max-width: min(50vw, calc(100vw - 24px));
  padding: 3px 7px;
  border-radius: var(--novel-r-sm);
  background: var(--novel-tooltip-bg);
  color: var(--novel-tooltip-label);
  font-size: 13px;
  line-height: 20px;
  white-space: pre-line;
  overflow-wrap: break-word;
  pointer-events: none;
}
.novel-moyu-tooltip-label { color: inherit; }
.novel-moyu-tooltip-key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 2px;
  border: 0;
  border-radius: 4px;
  background: var(--novel-tooltip-key-bg);
  color: inherit;
  font-size: 11px;
  line-height: 14px;
}

/* ═══ 输入面功能件：指令/引用 chip、明细面板、结果卡、附件/notice/Toast ═══════════ */
/* 已认领的指令 / 选中的章节引用（宿主 CommandChip·ReferenceChip 的 inline 芯片形制）。 */
.novel-moyu-chip-row { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 14px 0; }
.novel-moyu-cmd-chip, .novel-moyu-ref-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  max-width: 240px;
  padding: 0 4px;
  border: 0;
  border-radius: var(--novel-r-sm);
  background: transparent;
  color: var(--novel-business);
  font-size: inherit;
  line-height: inherit;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
@media (hover: hover) {
  .novel-moyu-cmd-chip:hover, .novel-moyu-ref-chip:hover { background: var(--novel-chip-hover); }
}
.novel-moyu-cmd-chip-label, .novel-moyu-ref-chip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* ContextMeter 明细面板（宿主 264px portal 面板：~N tok / M tok + 4px 分段条 + 三行图例）。 */
.novel-moyu-context-panel {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  width: min(264px, calc(100vw - 24px));
  padding: 12px;
  border: 0;
  border-radius: var(--novel-r-lg);
  background: var(--novel-layer-2);
  --novel-elevation-stroke-color: var(--novel-border);
  box-shadow: var(--novel-elevation-prominent);
  color: var(--novel-text-2);
  font-size: 12px;
  line-height: 18px;
}
.novel-moyu-context-total {
  display: block;
  color: var(--novel-text);
  font-variant-numeric: tabular-nums;
}
.novel-moyu-context-bar {
  display: flex;
  gap: 2px;
  height: 4px;
  margin: 10px 0 12px;
}
.novel-moyu-context-seg { min-width: 2px; border-radius: 2px; }
.novel-moyu-context-legend { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.novel-moyu-context-legend li { display: flex; align-items: center; gap: 8px; min-width: 0; }
.novel-moyu-context-swatch { flex: none; width: 8px; height: 8px; border-radius: 2px; }
.novel-moyu-context-legend-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.novel-moyu-context-legend-value { flex: none; color: var(--novel-text-3); font-variant-numeric: tabular-nums; }
/* 工具结果卡（宿主 ToolRow 展开体的排版口径）：路径行号在卡内，摘录压码底。 */
.novel-moyu-result-card {
  display: flex;
  flex-direction: column;
  gap: var(--novel-sp-2);
  margin: 4px 0 4px 22px;
  padding: 8px;
  border: 0.5px solid var(--novel-border-faint);
  border-radius: var(--novel-r-lg);
  background: var(--novel-code-bg);
  color: var(--novel-text-2);
  font-family: var(--novel-font-mono);
  font-size: var(--novel-fs-sm);
  line-height: 18px;
}
.novel-moyu-result-range { color: var(--novel-text-3); }
.novel-moyu-result-body {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 6;
}
/* 卡内 notice 行 / Toast（宿主 InputBar「.notice」与 toast 的形态）：有数据才渲染。 */
.novel-moyu-notice-row {
  width: 100%;
  margin: 0 0 6px;
  padding: 4px 8px;
  border-radius: var(--novel-r-md);
  background: var(--novel-hover);
  color: var(--novel-text-2);
  font-size: 12px;
  line-height: 18px;
}
.novel-moyu-toast {
  position: fixed;
  top: 40px;
  left: 50%;
  z-index: 1100;
  display: flex;
  align-items: center;
  gap: 10px;
  width: max-content;
  max-width: min(640px, calc(100vw - 48px));
  padding: 12px 16px;
  border-radius: var(--novel-r-lg);
  background: var(--novel-toast-bg);
  color: var(--novel-text);
  font-size: 14px;
  line-height: 22px;
  box-shadow: var(--novel-shadow-pop);
  transform: translateX(-50%);
}

/* ── 工作区入口（chip 座位与选择菜单）──────────────────────────────── */

@media (prefers-reduced-motion: reduce) {
  .novel-moyu-shimmer[data-active="true"], .novel-moyu-p.is-live,
  .novel-moyu-running-text.is-shimmer { animation: none; }
  .novel-moyu-process-chevron { transition: none; }
}
`