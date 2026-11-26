/** 阅读器块（`NOVEL_CSS` 的第 6 块）：控制器条、正文列、目录抽屉、Aa 面板，以及 EPUB
 *  三组件（图文正文 / 目录树 / 注释面板）的规则。 */
export const READER_CSS = `
/* ── 阅读器：控制器条/正文列/目录抽屉/Aa 面板（z 序仍归 CTRL_Z 常量，布局归样式类）── */
/* 纸面 full-bleed：**纸张色涂满整个阅读区**（值槽 --novel-paper 由 ReaderView 行内写在阅读区根上）。 */
.novel-rdr {
  position: relative; display: flex; flex-direction: column; min-height: 100vh;
  container-type: inline-size; container-name: novel-reader;
}
/* 滚动补偿归会话：裁章/前插由 reader-session 在渲染后按实测高度补 scrollTop。 */
.novel-rdr, .novel-rdr * { overflow-anchor: none; }
/* 控制器条**跟纸走，不跟宿主 chrome 走**：条底 = 纸往墨压一档，整屏读作「一张纸的顶部折了一道」。 */
.novel-rdr-bar {
  display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center; gap: var(--novel-sp-3); min-height: 48px;
  padding: 0 var(--novel-sp-5);
  border-bottom: 1px solid color-mix(in srgb, var(--novel-paper-ink) 12%, transparent);
  color: var(--novel-paper-ink);
}
/* 「控制器层跟随深色」仍是完整的一档：勾上即整条让回宿主暗底，纸色派生那一套整体作废。 */
.novel-rdr-bar.novel-dark {
  background: var(--novel-bg); color: var(--novel-text);
  border-bottom-color: var(--novel-border);
}
.novel-rdr-left { display: flex; align-items: center; gap: var(--novel-sp-2); min-width: 0; justify-self: start; }
/* 居中章节上下文触发钮：点中即可打开/关闭目录，书名退副位、章名与 N/M 居中主显。 */
.novel-rdr-context {
  min-width: 0; max-width: min(460px, 100%); justify-self: center;
  min-height: 40px; display: grid; align-content: center; gap: 1px;
  padding: 3px 12px; border: 0; border-radius: var(--novel-r-md);
  background: transparent; color: inherit; font: inherit; text-align: center; cursor: pointer;
  transition: background var(--novel-dur-fast) ease;
}
.novel-rdr-context:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.novel-rdr-book {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 10.5px; line-height: 1.2; opacity: .6;
}
.novel-rdr-chap-row {
  min-width: 0; display: flex; align-items: baseline; justify-content: center; gap: 7px;
  font-size: var(--novel-fs-md); overflow: hidden;
}
.novel-rdr-chap {
  min-width: 0; font-size: 13.5px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-rdr-pos {
  flex: none; font-size: var(--novel-fs-xs); opacity: .62; white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
/* 返回入口与读数之间的发丝 */
.novel-rdr-sep { width: 1px; height: 16px; flex: none; background: currentColor; opacity: .2; margin: 0 2px; }
/* 条上控件：质感圆角钮 + 微缩反馈 + 导出在途脉冲点 */
.novel-rdr-ctl {
  position: relative;
  font: inherit; font-size: var(--novel-fs-sm); min-height: 32px; padding: var(--novel-sp-1) var(--novel-sp-3);
  border: none; border-radius: var(--novel-r-md); background: none; cursor: pointer; color: inherit; opacity: .84;
  display: inline-flex; align-items: center; gap: var(--novel-sp-1); white-space: nowrap;
  transition: background var(--novel-dur-fast) ease, opacity var(--novel-dur-fast) ease,
    transform var(--novel-dur-fast) ease;
}
.novel-rdr-ctl:hover { background: color-mix(in srgb, currentColor 9%, transparent); opacity: 1; }
.novel-rdr-ctl:active:not(:disabled) { transform: scale(.97); }
.novel-rdr-ctl[aria-expanded="true"] {
  background: color-mix(in srgb, var(--novel-live-ink) 13%, transparent);
  color: var(--novel-live-ink); opacity: 1;
}
.novel-rdr-bar.novel-dark .novel-rdr-ctl[aria-expanded="true"] {
  background: var(--novel-brand-tint); color: var(--novel-brand-strong);
}
.novel-rdr-ctl.is-running::before {
  content: ""; position: absolute; top: 5px; right: 5px;
  width: 6px; height: 6px; border-radius: 50%; background: var(--novel-live-ink);
  animation: novel-pulse-dot 1.4s ease-in-out infinite;
}
.novel-rdr-bar.novel-dark .novel-rdr-ctl.is-running::before { background: var(--novel-brand); }
@keyframes novel-pulse-dot { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.3); opacity: .65; } }
.novel-rdr-ctl svg { width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.novel-rdr-ctl-aa { font-family: var(--novel-font-serif); font-size: 14px; font-weight: 600; letter-spacing: -.04em; }
.novel-rdr-back-origin {
  border-radius: 999px; background: color-mix(in srgb, currentColor 8%, transparent);
  font-size: var(--novel-fs-xs); padding: 3px 10px; min-height: 28px;
}
/* 章进度：跟随纸张跟读高亮色 / 深色跟随宿主 brand */
.novel-rdr-trail {
  position: absolute; left: 0; right: 0; bottom: 0; height: 2px; pointer-events: none;
  background: color-mix(in srgb, var(--novel-paper-ink) 9%, transparent);
}
.novel-rdr-trail::after {
  content: ''; display: block; width: 100%; height: 100%;
  background: color-mix(in srgb, var(--novel-live-ink) 78%, transparent);
  transform-origin: left; transform: scaleX(var(--novel-pct, 0));
  transition: transform var(--novel-dur) var(--novel-ease);
}
.novel-rdr-bar.novel-dark .novel-rdr-trail { background: var(--novel-border-faint); }
.novel-rdr-bar.novel-dark .novel-rdr-trail::after { background: var(--novel-brand); }
.novel-rdr-acts { display: flex; gap: var(--novel-sp-0); align-items: center; justify-self: end; }
.novel-rdr-main { position: relative; flex: 1 1 auto; min-height: 0; display: flex; align-items: flex-start; background: var(--novel-paper); }
/* 正文列宽固定像素：--novel-measure（缺省 680px，与字号解耦，行内由 prefs.measure 覆写）；衬线正文排版节奏。 */
.novel-rdr-body {
  flex: 1 1 auto; min-width: 0; max-width: var(--novel-measure); margin-inline: auto;
  overflow-y: auto; padding: 40px var(--novel-sp-5) calc(var(--novel-sp-7) * 3);
  color: var(--novel-paper-ink); font-family: var(--novel-font-serif); letter-spacing: .02em;
}
/* 连续滚动章标题：刊物风大字衬线标题 + 底部细衬线分隔，清晰区分章节层次。 */
.novel-rdr-body h2.novel-rdr-mark {
  display: block; font-family: var(--novel-font-serif);
  font-size: 1.28em; font-weight: 600; line-height: 1.35; letter-spacing: .02em;
  margin: 0 0 1em; padding-bottom: .55em;
  border-bottom: 1px solid color-mix(in srgb, var(--novel-paper-ink) 14%, transparent);
  text-wrap: balance;
}
.novel-rdr-body p {
  margin: 0 0 .85em; text-indent: 2em;
  transition: color var(--novel-dur-fast) ease;
}
.novel-rdr-body [data-chapter] + [data-chapter] { margin-top: 48px; }
.novel-rdr-loading { padding: var(--novel-sp-7) 0; text-align: center; opacity: .6; font-size: var(--novel-fs-md); }
.novel-sentinel {
  display: flex; align-items: center; gap: 12px;
  opacity: .55; font-size: var(--novel-fs-xs); letter-spacing: .08em;
  padding: var(--novel-sp-6) 0; text-align: center;
}
.novel-sentinel::before, .novel-sentinel::after {
  content: ''; flex: 1; height: 1px;
  background: color-mix(in srgb, var(--novel-paper-ink) 16%, transparent);
}
/* 目录抽屉：锚视口靠外层 .novel-drawer-slot 的 sticky，抽屉本体 absolute 浮在正文右缘。
   槽宽 0 + 绝对定位子件 = sticky 跟随性保留、正文列不缩水。 */
.novel-drawer-slot, .novel-notes-slot {
  position: sticky; align-self: flex-start; top: 48px;
  flex: none; width: 0; height: 0; z-index: var(--novel-z-panel);
}
/* 仅用纵向微移 + 淡入：避免 sticky 顶条里的浮层在横移或缩放动画期间触发 scrollIntoViewIfNeeded 连带跳滚正文。 */
@keyframes novel-panel-enter {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
@keyframes novel-reveal-down {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
.novel-drawer {
  position: absolute; right: var(--novel-sp-3); top: var(--novel-sp-3);
  width: min(336px, calc(100vw - 32px)); max-height: calc(100vh - 88px);
  overflow-y: auto; overscroll-behavior: contain;
  color: var(--novel-text);
  background: color-mix(in srgb, var(--novel-layer-2) 96%, transparent);
  backdrop-filter: blur(18px) saturate(1.15); -webkit-backdrop-filter: blur(18px) saturate(1.15);
  border: 1px solid var(--novel-border);
  border-radius: 13px; padding: 0 10px 12px;
  display: flex; flex-direction: column; gap: 2px;
  box-shadow: inset 0 1px 0 color-mix(in srgb, #ffffff 8%, transparent), var(--novel-shadow-2);
  animation: novel-panel-enter var(--novel-dur-mid) var(--novel-ease-out);
}
.novel-drawer-top {
  position: sticky; top: 0; z-index: 3;
  margin: 0 -10px 6px; padding: 10px 12px 10px;
  background: color-mix(in srgb, var(--novel-layer-2) 96%, transparent);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--novel-border-faint);
  display: flex; flex-direction: column; gap: 8px;
}
.novel-panel-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px;
}
.novel-panel-head-title {
  flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 6px;
  font-size: var(--novel-fs-md); font-weight: 600; color: var(--novel-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.novel-panel-head-sub {
  flex: none; font-size: var(--novel-fs-xs); font-weight: 400; color: var(--novel-text-3);
  font-variant-numeric: tabular-nums;
}
.novel-panel-close {
  flex: none; width: 28px; height: 28px; display: inline-grid; place-items: center;
  border: 0; border-radius: var(--novel-r-sm); background: transparent; color: var(--novel-text-3); cursor: pointer;
  transition: background var(--novel-dur-fast) ease, color var(--novel-dur-fast) ease;
}
.novel-panel-close:hover { background: var(--novel-hover); color: var(--novel-text); }
.novel-panel-close svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.novel-toc-toolbar { display: flex; align-items: center; gap: 6px; }
.novel-toc-search { position: relative; flex: 1 1 auto; min-width: 0; }
.novel-toc-search-ic {
  position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
  width: 14px; height: 14px; color: var(--novel-text-3); pointer-events: none;
  fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;
}
.novel-toc-search input {
  width: 100%; height: 32px; padding: 0 28px 0 30px;
  border: 1px solid var(--novel-border); border-radius: var(--novel-r-md);
  background: var(--novel-layer-1); color: var(--novel-text); font: inherit; font-size: var(--novel-fs-sm);
  transition: border-color var(--novel-dur-fast) ease, box-shadow var(--novel-dur-fast) ease;
}
.novel-toc-search input:focus-visible { outline: none; border-color: var(--novel-accent); box-shadow: 0 0 0 3px var(--novel-accent-soft); }
.novel-toc-search input::placeholder { color: var(--novel-text-3); }
.novel-toc-search input::-webkit-search-cancel-button,
.novel-toc-search input::-webkit-search-decoration { -webkit-appearance: none; appearance: none; }
.novel-toc-clear {
  position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
  width: 22px; height: 22px; display: inline-grid; place-items: center;
  border: 0; border-radius: var(--novel-r-xs); background: transparent; color: var(--novel-text-3); cursor: pointer;
}
.novel-toc-clear:hover { background: var(--novel-hover); color: var(--novel-text); }
.novel-toc-clear svg { width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.novel-toc-locate {
  flex: none; width: 32px; height: 32px; display: inline-grid; place-items: center;
  border: 1px solid var(--novel-border); border-radius: var(--novel-r-md);
  background: var(--novel-layer-1); color: var(--novel-text-2); cursor: pointer;
  transition: background var(--novel-dur-fast) ease, color var(--novel-dur-fast) ease, border-color var(--novel-dur-fast) ease;
}
.novel-toc-locate:hover { background: var(--novel-hover); color: var(--novel-text); border-color: var(--novel-border-strong); }
.novel-toc-locate svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
.novel-toc-count { font-size: var(--novel-fs-xs); color: var(--novel-text-3); font-variant-numeric: tabular-nums; }
.novel-toc-empty {
  padding: var(--novel-sp-6) var(--novel-sp-4); text-align: center;
  color: var(--novel-text-3); font-size: var(--novel-fs-sm);
}
.novel-drawer-item {
  flex: none;                                       /* 见上：可滚动容器里的 flex 条目必须先拒绝收缩 */
  position: relative; background: none; border: none; text-align: left; width: 100%; color: var(--novel-text-2);
  font: inherit; font-size: var(--novel-fs-md); padding: 7px 10px 7px 14px;
  cursor: pointer; border-radius: var(--novel-r-md);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: background var(--novel-dur-fast) ease, color var(--novel-dur-fast) ease;
}
.novel-drawer-item:hover { background: var(--novel-hover); color: var(--novel-text); }
/* 当前章：底色 + 左侧圆角胶囊指示条；选择器用 aria-current（语义与样式同一个源）。 */
.novel-drawer-item[aria-current="true"] {
  background: var(--novel-brand-tint); color: var(--novel-brand-strong); font-weight: 600;
}
.novel-drawer-item[aria-current="true"]::before {
  content: ""; position: absolute; left: 3px; top: 7px; bottom: 7px;
  width: 3px; border-radius: 99px; background: var(--novel-brand);
}
/* 偏好与导出卡：毛玻璃卡片 + 入场动效 + 分组式排版控件（重钉 color 防从 .novel-rdr-bar 继承 --novel-paper-ink） */
.novel-prefs {
  display: flex; flex-direction: column; padding: 0;
  width: min(332px, calc(100vw - 24px)); max-height: calc(100vh - 76px);
  overflow-y: auto; overscroll-behavior: contain;
  color: var(--novel-text);
  background: color-mix(in srgb, var(--novel-layer-2) 96%, transparent);
  backdrop-filter: blur(18px) saturate(1.15); -webkit-backdrop-filter: blur(18px) saturate(1.15);
  border: 1px solid var(--novel-border); border-radius: 13px;
  box-shadow: inset 0 1px 0 color-mix(in srgb, #ffffff 8%, transparent), var(--novel-shadow-2);
  animation: novel-panel-enter var(--novel-dur-mid) var(--novel-ease-out);
}
.novel-prefs > .novel-panel-head {
  padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--novel-border-faint); flex: none;
}
.novel-prefs-body { display: flex; flex-direction: column; padding: 12px 16px 14px; }
.novel-prefs-label { font-size: var(--novel-fs-xs); color: var(--novel-text-3); margin-bottom: var(--novel-sp-2); }
.novel-setting-section { padding: 12px 0; border-top: 1px solid var(--novel-border-faint); }
.novel-setting-section:first-child { padding-top: 0; border-top: 0; }
.novel-setting-title {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-bottom: 9px; font-size: var(--novel-fs-md); font-weight: 600; color: var(--novel-text);
}
.novel-setting-sublabel { font-size: var(--novel-fs-xs); color: var(--novel-text-3); margin: 10px 0 6px; }
.novel-setting-row {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 38px;
}
.novel-setting-row + .novel-setting-row { border-top: 1px solid var(--novel-border-faint); margin-top: 4px; padding-top: 4px; }
.novel-setting-row-label { font-size: var(--novel-fs-sm); color: var(--novel-text-2); white-space: nowrap; }
/* 连体字号步进胶囊 */
.novel-stepper {
  display: inline-flex; align-items: stretch; height: 34px;
  border: 1px solid var(--novel-border); border-radius: 9px; overflow: hidden;
  background: var(--novel-float);
}
.novel-stepper button {
  width: 36px; border: 0; background: transparent; color: var(--novel-text-2);
  font-family: var(--novel-font-serif); font-size: var(--novel-fs-md); cursor: pointer;
  display: inline-grid; place-items: center;
  transition: background var(--novel-dur-fast) ease, color var(--novel-dur-fast) ease;
}
.novel-stepper button:hover:not(:disabled) { background: var(--novel-hover); color: var(--novel-text); }
.novel-stepper button:disabled { opacity: .35; cursor: not-allowed; }
.novel-stepper span {
  min-width: 50px; display: inline-grid; place-items: center; padding: 0 6px;
  border-left: 1px solid var(--novel-border-faint); border-right: 1px solid var(--novel-border-faint);
  font-size: var(--novel-fs-sm); font-variant-numeric: tabular-nums; color: var(--novel-text);
  background: color-mix(in srgb, #000000 5%, var(--novel-layer-2));
}
/* 渐变填充滑块 */
.novel-range-ctl { display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; max-width: 176px; }
.novel-range-ctl output {
  min-width: 34px; text-align: right; color: var(--novel-text-2);
  font-size: var(--novel-fs-sm); font-variant-numeric: tabular-nums;
}
.novel-rdr-range {
  appearance: none; -webkit-appearance: none;
  width: 100%; min-width: 0; height: 26px; margin: 0; padding: 0;
  background: transparent; cursor: pointer;
}
.novel-rdr-range::-webkit-slider-runnable-track {
  height: 5px; border-radius: 999px;
  background: linear-gradient(
    90deg,
    var(--novel-accent) 0%,
    var(--novel-accent) var(--novel-range-fill),
    var(--novel-border-strong) var(--novel-range-fill),
    var(--novel-border-strong) 100%
  );
}
.novel-rdr-range::-webkit-slider-thumb {
  appearance: none; -webkit-appearance: none;
  width: 15px; height: 15px; margin-top: -5px;
  border: 2px solid var(--novel-layer-2); border-radius: 50%;
  background: var(--novel-accent); box-shadow: 0 1px 4px rgba(0, 0, 0, .25);
  transition: transform var(--novel-dur-fast) var(--novel-ease-spring), box-shadow var(--novel-dur-fast) ease;
}
.novel-rdr-range:hover::-webkit-slider-thumb { transform: scale(1.14); }
.novel-rdr-range:active::-webkit-slider-thumb {
  transform: scale(1.06);
  box-shadow: 0 0 0 4px var(--novel-accent-soft), 0 1px 4px rgba(0, 0, 0, .25);
}
.novel-rdr-range::-moz-range-track { height: 5px; border-radius: 999px; background: var(--novel-border-strong); }
.novel-rdr-range::-moz-range-progress { height: 5px; border-radius: 999px; background: var(--novel-accent); }
.novel-rdr-range::-moz-range-thumb {
  width: 15px; height: 15px; border: 2px solid var(--novel-layer-2); border-radius: 50%;
  background: var(--novel-accent); box-shadow: 0 1px 4px rgba(0, 0, 0, .25);
}
/* 滑动指示胶囊分段器（grid 均分 + 整数列移位，零 DOM 测高抖动；深浅双态都保住凹槽与凸起胶囊层次） */
.novel-rdr-seg {
  position: relative; display: grid; grid-template-columns: repeat(var(--novel-seg-count, 2), minmax(0, 1fr));
  padding: 3px; border-radius: 9px;
  background: color-mix(in srgb, #000000 7%, var(--novel-layer-2));
  border: 1px solid var(--novel-border-faint);
}
.novel-dark .novel-rdr-seg { background: var(--novel-layer-1); }
.novel-rdr-seg-thumb {
  position: absolute; top: 3px; bottom: 3px; left: 3px; z-index: 0;
  width: calc((100% - 6px) / var(--novel-seg-count, 2));
  border-radius: 6.5px; background: var(--novel-float);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #ffffff 10%, transparent), 0 1px 4px rgba(0, 0, 0, .18), 0 0 0 1px var(--novel-border-faint);
  transform: translateX(calc(var(--novel-seg-index, 0) * 100%));
  transition: transform var(--novel-dur-mid) var(--novel-ease-spring);
  pointer-events: none;
}
.novel-rdr-seg button {
  position: relative; z-index: 1; min-height: 30px; padding: 0 6px;
  border: 0; border-radius: 6.5px; background: transparent;
  color: var(--novel-text-2); font: inherit; font-size: var(--novel-fs-sm); white-space: nowrap; cursor: pointer;
  transition: color var(--novel-dur-fast) ease;
}
.novel-rdr-seg button:hover:not(:disabled) { color: var(--novel-text); }
.novel-rdr-seg button.on { color: var(--novel-text); font-weight: 600; }
.novel-rdr-seg button:disabled { opacity: .45; cursor: not-allowed; }
/* 翻页动效二级胶囊 */
.novel-reveal-down { animation: novel-reveal-down var(--novel-dur-mid) var(--novel-ease-out); }
.novel-rdr-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.novel-rdr-pill {
  flex: 1; min-height: 30px; padding: 0 8px;
  border: 1px solid var(--novel-border); border-radius: 999px;
  background: transparent; color: var(--novel-text-2); font: inherit; font-size: var(--novel-fs-sm);
  white-space: nowrap; cursor: pointer;
  transition: background var(--novel-dur-fast) ease, border-color var(--novel-dur-fast) ease, color var(--novel-dur-fast) ease;
}
.novel-rdr-pill:hover:not(:disabled) { background: var(--novel-hover); color: var(--novel-text); }
.novel-rdr-pill.on { background: var(--novel-accent-soft); border-color: var(--novel-accent-line); color: var(--novel-brand-strong); font-weight: 600; }
/* 6 列命名纸面色卡 + 自定义彩虹环 */
.novel-swatches { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; }
.novel-swatch-item { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 0; }
.novel-swatch-name {
  font-size: 10.5px; color: var(--novel-text-3); line-height: 1.2; white-space: nowrap;
  transition: color var(--novel-dur-fast) ease;
}
.novel-swatch-item:has(.on) .novel-swatch-name { color: var(--novel-brand-strong); font-weight: 600; }
.novel-rdr-swatch, .novel-rdr-custom-swatch {
  position: relative; width: 32px; height: 32px; padding: 0; border-radius: 50%; cursor: pointer;
  display: inline-grid; place-items: center;
  transition: transform var(--novel-dur-fast) var(--novel-ease-spring), box-shadow var(--novel-dur-fast) ease;
}
.novel-rdr-swatch {
  border: 2px solid var(--novel-layer-2);
  box-shadow: 0 0 0 1px var(--novel-border-strong) inset;
}
.novel-rdr-swatch:hover, .novel-rdr-custom-swatch:hover { transform: translateY(-2px); }
.novel-rdr-swatch.on { box-shadow: 0 0 0 2px var(--novel-accent), 0 0 0 1px var(--novel-border-strong) inset; }
.novel-rdr-custom-swatch {
  padding: 2.5px; border: 0;
  background: conic-gradient(from 20deg, #ef6b6b, #e9b44c, #65b96f, #4f8fe8, #8f72dc, #e26aa5, #ef6b6b);
  box-shadow: 0 0 0 1px var(--novel-border-strong);
}
.novel-rdr-custom-swatch.on { box-shadow: 0 0 0 2px var(--novel-accent); }
.novel-custom-swatch-core {
  display: inline-grid; place-items: center; width: 100%; height: 100%;
  border: 2px solid var(--novel-layer-2); border-radius: 50%;
  background: var(--novel-layer-2); color: var(--novel-text);
}
.novel-swatch-check {
  width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2.4;
  stroke-linecap: round; stroke-linejoin: round; pointer-events: none;
  opacity: 0; transform: scale(.4);
  transition: opacity var(--novel-dur-fast) ease, transform var(--novel-dur-mid) var(--novel-ease-spring);
}
.novel-rdr-swatch.on .novel-swatch-check,
.novel-rdr-custom-swatch.on .novel-swatch-check { opacity: 1; transform: scale(1); }
/* 自定义取色器与实时对比度预览 */
.novel-custom-picker {
  display: grid; gap: 9px; margin-top: 12px; padding-top: 12px;
  border-top: 1px solid var(--novel-border-faint);
  animation: novel-reveal-down var(--novel-dur-mid) var(--novel-ease-out);
}
.novel-custom-preview {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 9px 11px; border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--novel-picker-ink) 18%, transparent);
  background: var(--novel-picker-color); color: var(--novel-picker-ink);
}
.novel-custom-preview-text { font-family: var(--novel-font-serif); font-size: var(--novel-fs-md); line-height: 1.4; min-width: 0; }
.novel-custom-preview-live { color: var(--novel-picker-live); font-weight: 600; }
.novel-custom-preview-badge {
  flex: none; padding: 2px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600;
  font-variant-numeric: tabular-nums;
  background: color-mix(in srgb, var(--novel-picker-ink) 12%, transparent);
  color: var(--novel-picker-ink);
}
.novel-hex-field {
  display: flex; align-items: center; gap: 4px; height: 32px; padding: 0 10px;
  border: 1px solid var(--novel-border); border-radius: var(--novel-r-md);
  background: var(--novel-layer-1); color: var(--novel-text-3); font-size: var(--novel-fs-sm);
}
.novel-hex-field:focus-within { border-color: var(--novel-accent); box-shadow: 0 0 0 3px var(--novel-accent-soft); }
.novel-hex-field input {
  width: 100%; min-width: 0; border: 0; background: transparent; color: var(--novel-text);
  font-family: ui-monospace, Consolas, monospace; font-size: var(--novel-fs-sm); text-transform: uppercase;
}
.novel-hex-field input:focus-visible { outline: none; }
.novel-color-slider-row {
  display: grid; grid-template-columns: 32px minmax(0, 1fr) 36px; align-items: center; gap: 8px;
  color: var(--novel-text-2); font-size: var(--novel-fs-xs);
}
.novel-color-slider-row output { text-align: right; color: var(--novel-text-3); font-variant-numeric: tabular-nums; }
.novel-color-slider {
  appearance: none; -webkit-appearance: none; width: 100%; height: 24px; padding: 8px 0;
  border-radius: 999px; background-clip: content-box; cursor: pointer;
}
.novel-color-slider.is-h {
  background-image: linear-gradient(90deg, hsl(0 80% 56%), hsl(60 80% 56%), hsl(120 80% 50%), hsl(180 80% 50%), hsl(240 80% 62%), hsl(300 80% 56%), hsl(360 80% 56%));
}
.novel-color-slider.is-s {
  background-image: linear-gradient(90deg, hsl(var(--novel-picker-h) 0% var(--novel-picker-l)), hsl(var(--novel-picker-h) 100% var(--novel-picker-l)));
}
.novel-color-slider.is-l {
  background-image: linear-gradient(90deg, hsl(var(--novel-picker-h) var(--novel-picker-s) 6%), hsl(var(--novel-picker-h) var(--novel-picker-s) 52%), hsl(var(--novel-picker-h) var(--novel-picker-s) 96%));
}
.novel-color-slider::-webkit-slider-thumb {
  appearance: none; -webkit-appearance: none; width: 16px; height: 16px;
  border: 2px solid var(--novel-layer-2); border-radius: 50%;
  background: var(--novel-picker-color); box-shadow: 0 1px 4px rgba(0, 0, 0, .28);
}
.novel-color-slider::-moz-range-thumb {
  width: 16px; height: 16px; border: 2px solid var(--novel-layer-2); border-radius: 50%;
  background: var(--novel-picker-color); box-shadow: 0 1px 4px rgba(0, 0, 0, .28);
}
.novel-contrast-warn {
  padding: 7px 9px; border-radius: var(--novel-r-md);
  border: 1px solid color-mix(in srgb, var(--novel-warn) 42%, transparent);
  background: color-mix(in srgb, var(--novel-warn) 10%, transparent);
  color: var(--novel-warn); font-size: var(--novel-fs-xs); line-height: 1.5;
}
.novel-custom-done {
  justify-self: end; min-height: 30px; padding: 0 12px;
  border: 1px solid var(--novel-border); border-radius: var(--novel-r-md);
  background: transparent; color: var(--novel-text-2); font: inherit; font-size: var(--novel-fs-xs); cursor: pointer;
}
.novel-custom-done:hover { background: var(--novel-hover); color: var(--novel-text); }
/* 控制器深色弹簧开关（原生 checkbox 保持无障碍完整，轨道+滑块视觉对齐） */
.novel-switch-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-top: 12px; cursor: pointer;
}
.novel-switch-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.novel-switch-copy span { font-size: var(--novel-fs-sm); color: var(--novel-text-2); }
.novel-switch-copy small { font-size: var(--novel-fs-xs); color: var(--novel-text-3); }
.novel-rdr-switch { position: relative; flex: none; width: 42px; height: 24px; display: inline-block; }
.novel-rdr-switch-input {
  position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; z-index: 1;
}
.novel-rdr-switch-track {
  position: relative; display: block; width: 100%; height: 100%;
  border-radius: 999px; background: color-mix(in srgb, var(--novel-text) 22%, transparent);
  transition: background var(--novel-dur-mid) var(--novel-ease-out);
}
.novel-rdr-switch-track::after {
  content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px;
  border-radius: 50%; background: var(--novel-on-solid); box-shadow: 0 1px 3px rgba(0, 0, 0, .24);
  transition: transform var(--novel-dur-mid) var(--novel-ease-spring);
}
.novel-rdr-switch-input:checked + .novel-rdr-switch-track { background: var(--novel-accent); }
.novel-rdr-switch-input:checked + .novel-rdr-switch-track::after { transform: translateX(18px); }
.novel-prefs-reset-row { padding-top: 10px; border-top: 1px solid var(--novel-border-faint); display: flex; }
.novel-prefs-reset {
  display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 8px;
  border: 0; border-radius: var(--novel-r-md); background: transparent;
  color: var(--novel-text-2); font: inherit; font-size: var(--novel-fs-xs); cursor: pointer;
  transition: background var(--novel-dur-fast) ease, color var(--novel-dur-fast) ease;
}
.novel-prefs-reset:hover { background: var(--novel-hover); color: var(--novel-brand-strong); }
.novel-prefs-reset svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
/* 导出范围面板 */
.novel-export-body { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; }
.novel-range-pair { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: end; gap: 8px; }
.novel-range-dash { height: 34px; display: grid; place-items: center; color: var(--novel-text-3); font-size: var(--novel-fs-md); }
.novel-export-field { display: flex; flex-direction: column; gap: 5px; }
.novel-export-field > span { font-size: var(--novel-fs-xs); color: var(--novel-text-2); }
.novel-export-field input {
  width: 100%; height: 34px; padding: 0 10px; border: 1px solid var(--novel-border);
  border-radius: var(--novel-r-md); background: var(--novel-layer-1); color: var(--novel-text);
  font: inherit; font-size: var(--novel-fs-md); font-variant-numeric: tabular-nums;
  transition: border-color var(--novel-dur-fast) ease, box-shadow var(--novel-dur-fast) ease;
}
.novel-export-field input:hover { border-color: var(--novel-border-strong); }
.novel-export-field input:focus-visible { outline: none; border-color: var(--novel-accent); box-shadow: 0 0 0 3px var(--novel-accent-soft); }
.novel-export-field input[aria-invalid="true"] { border-color: var(--novel-err); }
.novel-export-error { font-size: var(--novel-fs-xs); color: var(--novel-err); line-height: 1.45; }
.novel-export-notice {
  display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-radius: 9px;
  border: 1px solid var(--novel-border-faint);
  background: color-mix(in srgb, var(--novel-text) 5%, transparent); color: var(--novel-text-2); font-size: var(--novel-fs-xs); line-height: 1.45;
}
.novel-export-notice svg { width: 14px; height: 14px; flex: none; color: var(--novel-text-3); fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.novel-export-progress {
  display: grid; gap: 8px; padding: 12px; border: 1px solid var(--novel-border-faint);
  border-radius: 9px; background: color-mix(in srgb, var(--novel-text) 5%, transparent);
}
.novel-export-bar { position: relative; height: 5px; overflow: hidden; border-radius: 99px; background: var(--novel-border); }
.novel-export-bar i { display: block; width: 42%; height: 100%; background: var(--novel-accent); transform-origin: left; }
.novel-export-bar.streaming i { animation: novel-export-stream 1.15s ease-in-out infinite; }
@keyframes novel-export-stream { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
.novel-export-meta { font-size: var(--novel-fs-xs); color: var(--novel-text-2); font-variant-numeric: tabular-nums; }
.novel-export-actions { display: flex; gap: 8px; }
.novel-export-actions > .novel-btn {
  color: var(--novel-text-2); border-color: var(--novel-border); background: transparent;
}
.novel-export-actions > .novel-btn:hover:not(:disabled) {
  background: var(--novel-hover); color: var(--novel-text); border-color: var(--novel-border-strong);
}
.novel-export-actions > .novel-btn.primary {
  flex: 1; background: var(--novel-accent); border-color: var(--novel-accent); color: var(--novel-on-solid);
}
.novel-export-actions > .novel-btn.primary:hover:not(:disabled) {
  background: var(--novel-accent-hover); border-color: var(--novel-accent-hover);
}
/* ── 图文正文 / 目录树 / 注释面板（EPUB 三组件，规则一律住本层）───────────────
   三条口径：
   ① 正文组件**不钉颜色与字号**，只继承容器——它同在两处渲染（阅读流是纸张色 + 阅读设置字号，
      注释面板是控制器层 token），组件自己钉色必有一处不可读；下面这组规则只管结构与间距。
   ② 动态量走值槽（--novel-fig-ratio，由 ChapterBody 行内写可信比值），规则里不落行内像素。
   ③ 宽内容在阅读栏内滚（.novel-table-wrap / 图片 max-width），代价是内滚，不是整页横滚。 */
.novel-body { min-width: 0; }
.novel-body p { margin: 0 0 .85em; text-indent: 2em; }
.novel-notes .novel-body p { margin: .5em 0; }
.novel-body h1, .novel-body h2, .novel-body h3, .novel-body h4, .novel-body h5, .novel-body h6 {
  margin: 1.1em 0 .5em; font-weight: 600; line-height: 1.35; text-indent: 0;
}
.novel-body ul, .novel-body ol { margin: .5em 0; padding-left: 2em; }
.novel-body li { margin: var(--novel-sp-1) 0; }
.novel-body blockquote {
  margin: .8em 0; padding-left: var(--novel-sp-5);
  border-left: 3px solid var(--novel-border-strong); text-indent: 0;
}
/* pre 的空白是内容不是排版：换行与缩进原样保留；折行靠 pre-wrap + word-break。 */
.novel-body pre {
  margin: .8em 0; padding: var(--novel-sp-4); border-radius: var(--novel-r-xs);
  background: var(--novel-skeleton); overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  text-indent: 0; font-family: ui-monospace, Consolas, monospace; font-size: .95em;
}
.novel-body code { font-family: ui-monospace, Consolas, monospace; font-size: .95em; }
.novel-body sup, .novel-body sub { font-size: .75em; line-height: 0; }
.novel-body hr { margin: 1.4em 0; border: none; border-top: 1px solid var(--novel-border); }
/* 宽表在栏内滚：滚动归容器，否则整页被一张表撑出横滚条。 */
.novel-table-wrap { margin: .8em 0; max-width: 100%; overflow-x: auto; text-indent: 0; }
.novel-body table { border-collapse: collapse; max-width: 100%; }
.novel-body th, .novel-body td {
  border: 1px solid var(--novel-border); padding: var(--novel-sp-1) var(--novel-sp-3); vertical-align: top;
}
.novel-body caption { color: var(--novel-text-3); font-size: var(--novel-fs-sm); text-align: left; }
/* 插图：按可信宽高比先占位，加载完成/失败都不收缩框（失败只换内容）。 */
.novel-fig {
  display: block; margin: var(--novel-sp-5) auto; width: 100%; max-width: 100%;
  aspect-ratio: var(--novel-fig-ratio, 4 / 3); text-indent: 0;
  background: var(--novel-skeleton); border-radius: var(--novel-r-xs); overflow: hidden;
}
.novel-fig img { display: block; width: 100%; height: 100%; object-fit: contain; }
.novel-fig-fail {
  display: grid; place-items: center; height: 100%;
  font-size: var(--novel-fs-sm); color: var(--novel-text-3);
}
/* 正文内链：不是 <a>（raw href = 可点击导航）而是按钮——字色继承、能聚焦。 */
.novel-ref {
  font: inherit; color: inherit; padding: 0; border: none; background: none; cursor: pointer;
  text-align: left; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: .18em;
}
/* 含块级内容的链接本身是块级容器，且**宽度要显式写满**（否则插图框塌成 0）。 */
.novel-ref-block { display: block; width: 100%; }
/* 链接内容里的块级子节点：button 只收短语级元素，降级成 span。 */
.novel-ref-part { display: block; }
.novel-ref-rule { border-top: 1px solid var(--novel-border-strong); margin: .8em 0; }
/* 目录树：深度靠嵌套列表（结构即层级，不写行内缩进值）；组头不可点，故不是按钮样。 */
.novel-nav { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--novel-sp-0); }
.novel-nav .novel-nav { padding-left: var(--novel-sp-4); }
.novel-nav-group {
  padding: var(--novel-sp-2) var(--novel-sp-4) 0;
  color: var(--novel-text-3); font-size: var(--novel-fs-sm); font-weight: 600;
}
/* 注释面板（与导入说明面板同几何）：尺寸与锚定都走目录抽屉那一条。 */
.novel-notes {
  position: absolute; right: var(--novel-sp-3); top: var(--novel-sp-3); z-index: var(--novel-z-panel);
  display: flex; flex-direction: column; width: min(376px, calc(100vw - 32px));
  max-height: calc(100vh - 88px); overflow: hidden;
  color: var(--novel-text);
  background: color-mix(in srgb, var(--novel-layer-2) 96%, transparent);
  backdrop-filter: blur(18px) saturate(1.15); -webkit-backdrop-filter: blur(18px) saturate(1.15);
  border: 1px solid var(--novel-border);
  border-radius: 13px;
  box-shadow: inset 0 1px 0 color-mix(in srgb, #ffffff 8%, transparent), var(--novel-shadow-2);
  animation: novel-panel-enter var(--novel-dur-mid) var(--novel-ease-out);
}
.novel-notes-head {
  flex-wrap: nowrap; padding: 10px 12px 10px 16px;
  border-bottom: 1px solid var(--novel-border-faint);
}
.novel-notes-title { flex: 1 1 auto; text-align: left; font-size: var(--novel-fs-md); font-weight: 600; color: var(--novel-text); }
.novel-notes-body {
  padding: 12px 16px 16px;
  overflow-y: auto; overscroll-behavior: contain;
  font-family: var(--novel-font-serif); font-size: var(--novel-fs-base); line-height: 1.75;
}
/* 导入说明清单（导入回执与阅读器面板共用）：一条 = 码 + 资源 + 人读的交代。 */
.novel-warn-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--novel-sp-3); }
.novel-warn-list li { text-indent: 0; }
.novel-warn-code { font-size: var(--novel-fs-xs); color: var(--novel-warn); font-family: ui-monospace, Consolas, monospace; }
/* 导入回执：只在有持久告警时出现；左缘竖条说「这是说明不是错误」。 */
.novel-import-note {
  display: flex; flex-direction: column; gap: var(--novel-sp-2);
  margin: var(--novel-sp-4) 0; padding: var(--novel-sp-4) var(--novel-sp-5);
  background: var(--novel-layer-2); border: 1px solid var(--novel-border);
  border-left: 3px solid var(--novel-warn); border-radius: var(--novel-r-md); box-shadow: var(--novel-shadow-1);
}
.novel-import-head { display: flex; align-items: center; gap: var(--novel-sp-4); }
.novel-import-head > .novel-cover, .novel-import-head > .novel-cover-fallback {
  width: 44px; margin-bottom: 0; flex: none;
}
.novel-import-who { min-width: 0; display: flex; flex-direction: column; gap: var(--novel-sp-0); }
.novel-import-acts { display: flex; justify-content: flex-end; gap: var(--novel-sp-3); }
/* ── 跟读高亮（正在被念的那一段）───────────────────────────────────────── */
/* 换字色 + 段首一枚小三角（ADR-0076）；不铺底色、不画段内进度线。 */
.novel-tts-live { position: relative; color: var(--novel-live-ink); }
.novel-tts-live::before {
  content: ''; position: absolute; left: -1em; top: .38em;
  width: 0; height: 0; border-top: .4em solid transparent; border-bottom: .4em solid transparent;
  border-left: .5em solid currentColor; pointer-events: none;
}
/* 注释面板复用 ChapterBody 但不带听书语义（那里永不出现命中块）。 */
.novel-notes .novel-tts-live::before { display: none; }
/* ── 翻页阅读模式：厚实体书舞台、自适应单/双页摊开与三种翻页动效 ──────────── */
/* height: 100% 贴合 .novel-main 实测高度（不硬写 100vh，避免宿主顶栏存在时出现多余纵滚）。
   .novel-book-stage 设 z-index: 0 + isolation: isolate，把书页/书脊/翻页层全部关进独立层叠上下文，
   确保底部 .novel-tts-bar（z-index: var(--novel-z-status)）及其听书设置弹层、目录抽屉、注释面板、Aa/导出面板永远压在书页之上。 */
.novel-rdr.is-paged { height: 100%; min-height: 100%; overflow: hidden; }
.novel-rdr.is-paged .novel-rdr-main { flex: 1 1 0; min-height: 0; overflow: visible; align-items: stretch; }
.novel-book-stage {
  position: relative; z-index: 0; isolation: isolate;
  flex: 1 1 auto; min-width: 0; min-height: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 10px 12px 20px;
  background: radial-gradient(
    ellipse at 50% 42%,
    color-mix(in srgb, var(--novel-paper-ink) 2%, var(--novel-paper)) 0%,
    color-mix(in srgb, var(--novel-paper-ink) 7%, var(--novel-paper)) 100%
  );
  color: var(--novel-paper-ink); overflow: hidden;
}
/* 外层硬壳书封：浅暖布纹精装与深纸夜间深岩双态自适应 */
.novel-book-cover {
  position: relative; display: flex; align-items: stretch; max-width: 100%;
  border-radius: 12px;
  background: linear-gradient(
    145deg,
    color-mix(in srgb, var(--novel-paper) 86%, #8c765a) 0%,
    color-mix(in srgb, var(--novel-paper) 76%, #735f47) 100%
  );
  border: 1px solid color-mix(in srgb, var(--novel-paper-ink) 13%, transparent);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, .36),
    0 18px 44px color-mix(in srgb, var(--novel-paper-ink) 13%, transparent),
    0 6px 16px color-mix(in srgb, var(--novel-paper-ink) 7%, transparent),
    0 2px 4px color-mix(in srgb, var(--novel-paper-ink) 5%, transparent);
}
.novel-book-stage[data-paper-dark="true"] .novel-book-cover {
  background: linear-gradient(
    145deg,
    color-mix(in srgb, var(--novel-paper) 88%, #2a3038) 0%,
    color-mix(in srgb, var(--novel-paper) 94%, #0d0f12) 100%
  );
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, .08),
    0 18px 44px rgba(0, 0, 0, .42),
    0 6px 16px rgba(0, 0, 0, .26);
}
.novel-book-cover.is-spread { padding: 6px 6px 10px; }
.novel-book-cover.is-single { padding: 6px 6px 10px 5px; }
/* 双页精装封面中央书脊衬底：清淡雅致，不抢正文视觉。 */
.novel-book-binding-back {
  position: absolute; top: 0; bottom: 0; left: 50%; width: 38px;
  transform: translateX(-50%); pointer-events: none; z-index: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--novel-paper-ink) 6%, transparent) 35%,
    color-mix(in srgb, var(--novel-paper-ink) 12%, transparent) 50%,
    color-mix(in srgb, var(--novel-paper-ink) 6%, transparent) 65%,
    transparent 100%
  );
}
/* 左右厚实叠页书口：紧凑 12px 对称收边，把更多面积让给正文书页。 */
.novel-book-edge { flex: none; position: relative; z-index: 1; }
.novel-book-cover.is-spread .novel-book-edge-left {
  width: 12px; margin: 2px -2px -5px 0;
  border-radius: 7px 0 0 8px;
  background:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--novel-paper-ink) 12%, transparent) 0%,
      transparent 72%
    ),
    repeating-linear-gradient(
      90deg,
      var(--novel-paper) 0px,
      var(--novel-paper) 1.5px,
      color-mix(in srgb, var(--novel-paper-ink) 9%, var(--novel-paper)) 1.5px,
      color-mix(in srgb, var(--novel-paper-ink) 9%, var(--novel-paper)) 2.5px
    );
  box-shadow: inset 1px 0 2px color-mix(in srgb, var(--novel-paper-ink) 8%, transparent);
}
/* 单页模式左侧为柔和立体圆弧书脊。 */
.novel-book-cover.is-single .novel-book-edge-left {
  width: 12px; margin: 1px 0 -5px 0; border-radius: 6px 0 0 6px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper) 74%, #7a654c) 0%,
    color-mix(in srgb, var(--novel-paper) 86%, #8c765a) 54%,
    color-mix(in srgb, var(--novel-paper) 80%, #7a654c) 100%
  );
  box-shadow: inset -1px 0 3px color-mix(in srgb, var(--novel-paper-ink) 10%, transparent);
}
.novel-book-edge-right {
  width: 12px; margin: 2px 0 -5px -2px;
  border-radius: 0 7px 8px 0;
  background:
    linear-gradient(
      90deg,
      transparent 28%,
      color-mix(in srgb, var(--novel-paper-ink) 12%, transparent) 100%
    ),
    repeating-linear-gradient(
      90deg,
      var(--novel-paper) 0px,
      var(--novel-paper) 1.5px,
      color-mix(in srgb, var(--novel-paper-ink) 9%, var(--novel-paper)) 1.5px,
      color-mix(in srgb, var(--novel-paper-ink) 9%, var(--novel-paper)) 2.5px
    );
  box-shadow: inset -1px 0 2px color-mix(in srgb, var(--novel-paper-ink) 8%, transparent);
}
/* 底部厚实弯曲叠页切面：挂在 .novel-book-shell 内与 .novel-book-arch 共用同一坐标系与圆角曲线，
   从下方恰好托出 8px 弯曲叠纸厚度，中缝零错位、零断层。 */
.novel-book-edge-bottom {
  position: absolute; bottom: -8px; height: 22px; pointer-events: none; z-index: 0;
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--novel-paper-ink) 4%, transparent) 0%,
      transparent 48%,
      color-mix(in srgb, var(--novel-paper-ink) 10%, transparent) 100%
    ),
    repeating-linear-gradient(
      180deg,
      var(--novel-paper) 0px,
      var(--novel-paper) 1.5px,
      color-mix(in srgb, var(--novel-paper-ink) 8%, var(--novel-paper)) 1.5px,
      color-mix(in srgb, var(--novel-paper-ink) 8%, var(--novel-paper)) 2.5px
    );
  box-shadow: 0 2px 5px color-mix(in srgb, var(--novel-paper-ink) 9%, transparent);
}
.novel-book-edge-bottom.is-left {
  left: 0; width: 50%;
  border-radius: 0 0 26px 10px / 0 0 9px 5px;
}
.novel-book-edge-bottom.is-right {
  right: 0; width: 50%;
  border-radius: 0 0 10px 26px / 0 0 5px 9px;
}
.novel-book-edge-bottom.is-single {
  left: 0; right: 0;
  border-radius: 0 0 10px 3px / 0 0 6px 3px;
}
/* 书页本体：双页外壳本身透明，由左右两片拱形书页底衬（.novel-book-arch）拼出干净通透的 M 型弯曲书页轮廓。 */
.novel-book-shell {
  position: relative; z-index: 2; display: flex; flex-direction: column; align-items: center;
  padding: 16px 20px 10px;
  max-width: 100%;
}
.novel-book-zone-hint {
  position: absolute; top: 50%; transform: translateY(-50%); z-index: 4;
  width: 24px; height: 42px; display: grid; place-items: center;
  border-radius: 999px; color: color-mix(in srgb, var(--novel-paper-ink) 55%, transparent);
  font-size: 16px; opacity: 0; pointer-events: none;
  transition: opacity var(--novel-dur-fast) ease;
}
.novel-book-zone-hint.left { left: 2px; }
.novel-book-zone-hint.right { right: 2px; }
.novel-book-shell:hover .novel-book-zone-hint { opacity: .45; }
.novel-book-shell.is-spread,
.novel-book-shell.is-single {
  background: transparent;
}
/* 左右两片弯曲拱起的实体书页底衬：与下方 .novel-book-edge-bottom 使用完全一致的 50% 宽与拱弧半径。 */
.novel-book-arch {
  position: absolute; top: 0; bottom: 0; width: 50%; pointer-events: none; z-index: 1;
}
.novel-book-arch-single {
  left: 0; width: 100%;
  border-radius: 3px 10px 10px 3px / 3px 6px 6px 3px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper-ink) 7%, var(--novel-paper)) 0%,
    color-mix(in srgb, var(--novel-paper-ink) 2%, var(--novel-paper)) 5%,
    color-mix(in srgb, var(--novel-paper) 94%, #fff) 16%,
    var(--novel-paper) 82%,
    color-mix(in srgb, var(--novel-paper-ink) 3%, var(--novel-paper)) 95%,
    color-mix(in srgb, var(--novel-paper-ink) 6%, var(--novel-paper)) 100%
  );
  box-shadow:
    inset 2px 0 6px color-mix(in srgb, var(--novel-paper-ink) 5%, transparent),
    0 1px 4px color-mix(in srgb, var(--novel-paper-ink) 8%, transparent);
}
.novel-book-arch-left {
  left: 0;
  border-radius: 10px 26px 26px 10px / 5px 9px 9px 5px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper-ink) 5%, var(--novel-paper)) 0%,
    color-mix(in srgb, var(--novel-paper-ink) 1.5%, var(--novel-paper)) 5%,
    var(--novel-paper) 16%,
    color-mix(in srgb, var(--novel-paper) 92%, #fff) 46%,
    var(--novel-paper) 78%,
    color-mix(in srgb, var(--novel-paper-ink) 3%, var(--novel-paper)) 91%,
    color-mix(in srgb, var(--novel-paper-ink) 8%, var(--novel-paper)) 97.5%,
    color-mix(in srgb, var(--novel-paper-ink) 13%, var(--novel-paper)) 100%
  );
  box-shadow:
    inset 0 1px 2px rgba(255, 255, 255, .65),
    inset 2px 0 4px color-mix(in srgb, var(--novel-paper-ink) 4%, transparent),
    0 1px 3px color-mix(in srgb, var(--novel-paper-ink) 8%, transparent);
}
.novel-book-arch-right {
  right: 0;
  border-radius: 26px 10px 10px 26px / 9px 5px 5px 9px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper-ink) 14%, var(--novel-paper)) 0%,
    color-mix(in srgb, var(--novel-paper-ink) 7%, var(--novel-paper)) 3%,
    color-mix(in srgb, var(--novel-paper-ink) 2.5%, var(--novel-paper)) 11%,
    color-mix(in srgb, var(--novel-paper) 90%, #fff) 34%,
    var(--novel-paper) 68%,
    color-mix(in srgb, var(--novel-paper-ink) 1.5%, var(--novel-paper)) 94%,
    color-mix(in srgb, var(--novel-paper-ink) 5%, var(--novel-paper)) 100%
  );
  box-shadow:
    inset 0 1px 2px rgba(255, 255, 255, .65),
    inset -2px 0 4px color-mix(in srgb, var(--novel-paper-ink) 4%, transparent),
    0 1px 3px color-mix(in srgb, var(--novel-paper-ink) 8%, transparent);
}
.novel-book-stage[data-paper-dark="true"] .novel-book-arch-single,
.novel-book-stage[data-paper-dark="true"] .novel-book-arch-left,
.novel-book-stage[data-paper-dark="true"] .novel-book-arch-right {
  box-shadow: 0 1px 4px rgba(0, 0, 0, .35);
}
.novel-book-stage[data-paper-dark="true"] .novel-book-arch-left {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper) 92%, #000) 0%,
    var(--novel-paper) 16%,
    color-mix(in srgb, var(--novel-paper) 94%, var(--novel-paper-ink)) 48%,
    var(--novel-paper) 82%,
    color-mix(in srgb, var(--novel-paper) 78%, #000) 100%
  );
}
.novel-book-stage[data-paper-dark="true"] .novel-book-arch-right {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper) 78%, #000) 0%,
    var(--novel-paper) 18%,
    color-mix(in srgb, var(--novel-paper) 94%, var(--novel-paper-ink)) 52%,
    var(--novel-paper) 86%,
    color-mix(in srgb, var(--novel-paper) 92%, #000) 100%
  );
}
.novel-book-stage[data-paper-dark="true"] .novel-book-arch-single {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper) 84%, #000) 0%,
    var(--novel-paper) 16%,
    var(--novel-paper) 86%,
    color-mix(in srgb, var(--novel-paper) 90%, #000) 100%
  );
}
/* 双页中央立体书脊沟槽：极细柔和的凹陷折痕线 + 轻盈两侧柔影，不再叠成一条黑炭带。 */
.novel-book-spine {
  position: absolute; top: 4px; bottom: 4px; left: 50%; width: 48px;
  transform: translateX(-50%); pointer-events: none; z-index: 3;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--novel-paper-ink) 2%, transparent) 28%,
    color-mix(in srgb, var(--novel-paper-ink) 6%, transparent) 46%,
    color-mix(in srgb, var(--novel-paper-ink) 14%, transparent) 50%,
    color-mix(in srgb, var(--novel-paper-ink) 7%, transparent) 54%,
    color-mix(in srgb, var(--novel-paper-ink) 2%, transparent) 72%,
    transparent 100%
  );
}
/* 裁剪视口：外层 viewport 保持 overflow:visible，让 3D 翻页抬起的书页顶底角自然舒展不被割开；
   静态多栏正文只由内层 .novel-book-track-clip 裁剪。 */
.novel-book-viewport {
  position: relative; z-index: 2; overflow: visible;
}
.novel-book-track-clip {
  position: relative; overflow: hidden;
}
/* 多栏轨道：浏览器原生排版切页，不截断半行字；纯 CSS 轻盈柔焦过渡。
   跨章首帧先静止就位（无 is-settled），只在同章稳定后开启水平位移过渡，防止跨章从末页倒滑回第 0 页。 */
.novel-book-track {
  column-fill: auto; box-sizing: border-box;
  font-family: var(--novel-font-serif); letter-spacing: .02em;
  will-change: transform, filter; color: var(--novel-paper-ink);
  transition: none;
}
.novel-book-stage[data-page-anim="slide"] .novel-book-track.is-settled.is-sliding {
  transition: transform 320ms cubic-bezier(.22, 1, .36, 1);
}
.novel-book-stage[data-page-anim="slide"] .novel-book-track.is-sliding {
  animation: novel-slide-motion-blur 320ms cubic-bezier(.22, 1, .36, 1);
}
.novel-book-stage[data-page-anim="slide"] .novel-book-chapter.is-slide-enter-next {
  animation: novel-slide-enter-next 320ms cubic-bezier(.22, 1, .36, 1);
}
.novel-book-stage[data-page-anim="slide"] .novel-book-chapter.is-slide-enter-prev {
  animation: novel-slide-enter-prev 320ms cubic-bezier(.22, 1, .36, 1);
}
.novel-book-stage[data-page-anim="flip"] .novel-book-track.is-flipping {
  animation: novel-flip-text-soften 560ms cubic-bezier(.32, .08, .22, 1);
}
.novel-book-stage[data-page-anim="none"] .novel-book-track,
.novel-book-stage[data-page-anim="flip"] .novel-book-track {
  transition: none;
}
.novel-book-track h2.novel-rdr-mark {
  display: block; font-family: var(--novel-font-serif);
  font-size: 1.28em; font-weight: 600; line-height: 1.35; letter-spacing: .02em;
  margin: 0 0 1em; padding-bottom: .55em;
  border-bottom: 1px solid color-mix(in srgb, var(--novel-paper-ink) 14%, transparent);
  text-wrap: balance; break-after: avoid;
}
.novel-book-track p { margin: 0 0 .85em; text-indent: 2em; orphans: 2; widows: 2; }
/* 翻页模式下左页紧贴裁剪盒左缘，把跟读小三角收进首行 2em 缩进里；无缩进块不画外挂三角避免压字或被裁剪盒切掉。 */
.novel-book-track p.novel-tts-live::before { left: .55em; }
.novel-book-track .novel-tts-live:not(p)::before { display: none; }
.novel-book-track h1, .novel-book-track h2, .novel-book-track h3,
.novel-book-track h4, .novel-book-track h5, .novel-book-track h6 { break-after: avoid; }
.novel-book-track .novel-fig {
  max-height: calc(var(--novel-book-page-h, 520px) - 3em);
  break-inside: avoid;
}
/* ── 纯 CSS 轻盈拟真翻页层（零正文 DOM 复制）：柔焦半透纸页轻掠 + 柔和扫影 ─── */
.novel-book-flip-stage {
  position: absolute; inset: 0; z-index: 4; pointer-events: none;
  background: transparent; overflow: visible;
  perspective: 2000px; perspective-origin: 50% 46%;
}
/* 单层轻盈纸页：带 backdrop-filter 柔和虚化与曲面纸光渐变，微带 skewY 模拟柔软纸角掠过。 */
.novel-book-leaf {
  position: absolute; top: 0; bottom: 0; z-index: 3; pointer-events: none;
  border-radius: 2px;
  backdrop-filter: blur(2.5px); -webkit-backdrop-filter: blur(2.5px);
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper-ink) 7%, transparent) 0%,
    color-mix(in srgb, var(--novel-paper) 72%, transparent) 16%,
    color-mix(in srgb, var(--novel-paper) 82%, #fff) 50%,
    color-mix(in srgb, var(--novel-paper) 68%, transparent) 84%,
    color-mix(in srgb, var(--novel-paper-ink) 9%, transparent) 100%
  );
  box-shadow: 0 8px 24px color-mix(in srgb, var(--novel-paper-ink) 11%, transparent);
  will-change: transform, opacity;
}
.novel-book-leaf.is-spread.dir-next {
  left: 50%; width: 50%; transform-origin: left center;
  animation: novel-leaf-spread-next 560ms cubic-bezier(.32, .08, .22, 1) forwards;
}
.novel-book-leaf.is-spread.dir-prev {
  left: 0; width: 50%; transform-origin: right center;
  animation: novel-leaf-spread-prev 560ms cubic-bezier(.32, .08, .22, 1) forwards;
}
.novel-book-leaf.is-single.dir-next {
  left: 0; width: 100%; transform-origin: left center;
  animation: novel-leaf-single-next 520ms cubic-bezier(.32, .08, .22, 1) forwards;
}
.novel-book-leaf.is-single.dir-prev {
  left: 0; width: 100%; transform-origin: left center;
  animation: novel-leaf-single-prev 520ms cubic-bezier(.32, .08, .22, 1) forwards;
}
/* 底层轻柔扫影：克制清透不发黑。 */
.novel-book-cast-shadow {
  position: absolute; inset: 0; z-index: 2; pointer-events: none;
}
.novel-book-cast-shadow.is-spread.dir-next {
  background: linear-gradient(
    90deg,
    transparent 18%,
    color-mix(in srgb, var(--novel-paper-ink) 6%, transparent) 48%,
    color-mix(in srgb, var(--novel-paper-ink) 10%, transparent) 54%,
    transparent 82%
  );
  animation: novel-cast-spread-next 560ms cubic-bezier(.32, .08, .22, 1) forwards;
}
.novel-book-cast-shadow.is-spread.dir-prev {
  background: linear-gradient(
    90deg,
    transparent 18%,
    color-mix(in srgb, var(--novel-paper-ink) 10%, transparent) 46%,
    color-mix(in srgb, var(--novel-paper-ink) 6%, transparent) 52%,
    transparent 82%
  );
  animation: novel-cast-spread-prev 560ms cubic-bezier(.32, .08, .22, 1) forwards;
}
.novel-book-cast-shadow.is-single.dir-next {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper-ink) 10%, transparent) 0%,
    color-mix(in srgb, var(--novel-paper-ink) 4%, transparent) 42%,
    transparent 74%
  );
  animation: novel-cast-single-next 520ms cubic-bezier(.32, .08, .22, 1) forwards;
}
.novel-book-cast-shadow.is-single.dir-prev {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--novel-paper-ink) 10%, transparent) 0%,
    color-mix(in srgb, var(--novel-paper-ink) 4%, transparent) 42%,
    transparent 74%
  );
  animation: novel-cast-single-prev 520ms cubic-bezier(.32, .08, .22, 1) forwards;
}
@keyframes novel-leaf-spread-next {
  0% { transform: rotateY(0deg) skewY(0deg); opacity: 0; }
  14% { transform: rotateY(-20deg) skewY(-1.8deg); opacity: .82; }
  50% { transform: rotateY(-92deg) skewY(-2.4deg); opacity: .88; }
  84% { transform: rotateY(-164deg) skewY(-1.2deg); opacity: .55; }
  100% { transform: rotateY(-180deg) skewY(0deg); opacity: 0; }
}
@keyframes novel-leaf-spread-prev {
  0% { transform: rotateY(0deg) skewY(0deg); opacity: 0; }
  14% { transform: rotateY(20deg) skewY(1.8deg); opacity: .82; }
  50% { transform: rotateY(92deg) skewY(2.4deg); opacity: .88; }
  84% { transform: rotateY(164deg) skewY(1.2deg); opacity: .55; }
  100% { transform: rotateY(180deg) skewY(0deg); opacity: 0; }
}
@keyframes novel-leaf-single-next {
  0% { transform: rotateY(0deg) skewY(0deg); opacity: .12; }
  18% { transform: rotateY(-22deg) skewY(-1.6deg); opacity: .82; }
  60% { transform: rotateY(-88deg) skewY(-2.2deg); opacity: .68; }
  100% { transform: rotateY(-132deg) skewY(0deg); opacity: 0; }
}
@keyframes novel-leaf-single-prev {
  0% { transform: rotateY(-128deg) skewY(0deg); opacity: 0; }
  35% { transform: rotateY(-68deg) skewY(-2deg); opacity: .78; }
  82% { transform: rotateY(-14deg) skewY(-1deg); opacity: .48; }
  100% { transform: rotateY(0deg) skewY(0deg); opacity: 0; }
}
/* 翻页与平移期间的正文轻盈柔焦：不复制任何 DOM，丝滑省电。 */
@keyframes novel-flip-text-soften {
  0% { filter: blur(0px); opacity: 1; }
  32% { filter: blur(2.2px); opacity: .84; }
  68% { filter: blur(1px); opacity: .94; }
  100% { filter: blur(0px); opacity: 1; }
}
@keyframes novel-slide-motion-blur {
  0% { filter: blur(0px); opacity: 1; }
  35% { filter: blur(1.8px); opacity: .92; }
  100% { filter: blur(0px); opacity: 1; }
}
/* 跨章顺滑入场：往下一章从右往左滑入，往上一章从左往右滑入，避免从末页倒滚回 0px。 */
@keyframes novel-slide-enter-next {
  0% { transform: translate3d(72px, 0, 0); filter: blur(2px); opacity: .55; }
  100% { transform: translate3d(0, 0, 0); filter: blur(0px); opacity: 1; }
}
@keyframes novel-slide-enter-prev {
  0% { transform: translate3d(-72px, 0, 0); filter: blur(2px); opacity: .55; }
  100% { transform: translate3d(0, 0, 0); filter: blur(0px); opacity: 1; }
}
@keyframes novel-cast-spread-next {
  0% { opacity: 0; transform: translateX(18%); }
  48% { opacity: .9; transform: translateX(0%); }
  100% { opacity: 0; transform: translateX(-22%); }
}
@keyframes novel-cast-spread-prev {
  0% { opacity: 0; transform: translateX(-18%); }
  48% { opacity: .9; transform: translateX(0%); }
  100% { opacity: 0; transform: translateX(22%); }
}
@keyframes novel-cast-single-next {
  0% { opacity: .85; transform: translateX(18%); }
  55% { opacity: .55; transform: translateX(-8%); }
  100% { opacity: 0; transform: translateX(-32%); }
}
@keyframes novel-cast-single-prev {
  0% { opacity: 0; transform: translateX(-28%); }
  45% { opacity: .75; transform: translateX(-4%); }
  100% { opacity: 0; transform: translateX(14%); }
}
/* 底部页码与翻页控制条：去掉横穿书脊的硬分割线，让书脊自上而下自然贯通 */
.novel-book-footer {
  position: relative; z-index: 2;
  width: 100%; display: flex; align-items: center; justify-content: space-between;
  gap: var(--novel-sp-3); margin-top: 6px; padding-top: 4px;
  font-size: var(--novel-fs-xs); color: color-mix(in srgb, var(--novel-paper-ink) 62%, transparent);
}
.novel-rdr.is-paged.is-tts-open .novel-book-footer {
  visibility: hidden; pointer-events: none;
}
.novel-book-page-num { font-variant-numeric: tabular-nums; letter-spacing: .02em; }
.novel-book-nav {
  font: inherit; color: inherit; background: none; border: none; border-radius: 999px;
  padding: 2px var(--novel-sp-3); cursor: pointer;
  transition: background var(--novel-dur) var(--novel-ease), color var(--novel-dur) var(--novel-ease);
}
.novel-book-nav:hover:not(:disabled) {
  background: color-mix(in srgb, var(--novel-paper-ink) 9%, transparent);
  color: var(--novel-paper-ink);
}
.novel-book-nav:disabled { opacity: .32; cursor: default; }
@media (prefers-reduced-motion: reduce) {
  .novel-book-stage[data-page-anim="slide"] .novel-book-track,
  .novel-book-stage[data-page-anim="slide"] .novel-book-chapter,
  .novel-book-stage[data-page-anim="flip"] .novel-book-track { transition: none; animation: none; }
  .novel-book-flip-stage { display: none; }
  .novel-drawer, .novel-prefs, .novel-notes, .novel-reveal-down { animation: none; }
  .novel-export-bar.streaming i, .novel-rdr-ctl.is-running::before { animation: none; }
  .novel-rdr-seg-thumb, .novel-rdr-seg button, .novel-rdr-pill, .novel-rdr-swatch,
  .novel-rdr-custom-swatch, .novel-swatch-check, .novel-rdr-switch-track,
  .novel-rdr-switch-track::after, .novel-rdr-context, .novel-book-nav { transition: none; }
}
@container novel-reader (max-width: 680px) {
  .novel-rdr-bar { grid-template-columns: auto minmax(0, 1fr) auto; gap: 6px; padding: 0 var(--novel-sp-3); }
  .novel-rdr-back-label, .novel-rdr-book { display: none; }
  .novel-rdr-body { padding: 28px var(--novel-sp-4) calc(var(--novel-sp-7) * 2.5); }
  .novel-book-stage { padding: 6px 8px 20px; }
}
@container novel-reader (max-width: 500px) {
  .novel-rdr-bar { gap: 4px; padding: 0 var(--novel-sp-2); }
  .novel-rdr-acts { gap: 2px; }
  .novel-rdr-acts .novel-rdr-ctl { padding: 4px 6px; font-size: var(--novel-fs-xs); }
  .novel-rdr-sep { display: none; }
}
`
