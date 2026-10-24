/** 控件块（`NOVEL_CSS` 的第 3 块）：跨视图共用的焦点环一套 + 设置区启停开关
 *  （位移用 transform、状态由 aria-checked 表达）。 */
export const CONTROLS_CSS = `
/* ── 焦点环：一套覆盖所有交互件（brand 环 + 2px 偏移，压在深浅两种底上都找得着）──
   .novel-btn.primary 另有环色换色规则（brand 压 brand 等于没有）；手风琴退役后
   .novel-section-* 系列规则已随之删除（死代码不留）。 */
.novel-btn:focus-visible, .novel-rdr-ctl:focus-visible,
.novel-input:focus-visible, .novel-textarea:focus-visible, .novel-chip:focus-visible,
.novel-seg button:focus-visible, .novel-tabs button:focus-visible, .novel-menu button:focus-visible,
.novel-card:focus-visible, .novel-row-main:focus-visible,
.novel-city-source:focus-visible, .novel-city-kind:focus-visible, .novel-city-card:focus-visible,
.novel-drawer-item:focus-visible, .novel-switch:focus-visible, .novel-searchbox:focus-within,
.novel-ref:focus-visible {
  outline: 2px solid var(--novel-ring); outline-offset: 2px;
}
.novel-btn.primary:focus-visible { outline-color: var(--novel-text); }
.novel-input, .novel-textarea {
  font: inherit; font-size: var(--novel-fs-md); padding: var(--novel-sp-2) var(--novel-sp-4);
  border-radius: var(--novel-r-sm); border: 1px solid var(--novel-border-strong);
  color: inherit; background: var(--novel-layer-3);
  outline-offset: 2px;
}
.novel-input::placeholder, .novel-textarea::placeholder { color: var(--novel-text-3); }
.novel-textarea { width: 100%; font-family: ui-monospace, Consolas, monospace; }
.novel-panel { border: 1px solid var(--novel-border); border-radius: var(--novel-r-md); padding: var(--novel-sp-4); background: var(--novel-layer-2); }
/* 错误横幅（会话/导出失败）：弱底 + 徽标 + 重试钮，全靠标度；旧实现在视图里行内写死 */
.novel-error-banner { background: var(--novel-err-weak); margin: var(--novel-sp-3) 0; }
.novel-retry { margin-left: var(--novel-sp-4); }
/* 运行卡（导入 / 批量验证共用外壳）：brand 派生色浮层底，标题行窄时可折。
   复合选择器不是冗余：.novel-group（search.ts 那块）也写 gap，靠顺序决胜太脆。 */
.novel-group.novel-run-card {
  border: 1px solid var(--novel-brand-line); border-radius: var(--novel-r-md);
  background: var(--novel-brand-soft); padding: var(--novel-sp-5); gap: var(--novel-sp-3);
}
.novel-run-card-head { flex-wrap: wrap; gap: var(--novel-sp-2) var(--novel-sp-4); }
.novel-muted { color: var(--novel-text-3); font-size: var(--novel-fs-sm); }
/* 场景内提示行（书架导入/加载错误等）：字号走标度，不再行内 fontSize */
.novel-note-sm { font-size: var(--novel-fs-sm); }
.novel-note-md { font-size: var(--novel-fs-md); line-height: 1.6; }
/* 隐藏的原生 file input（由拖放区/自绘钮触发）：display:none 不进无障碍树，
   触发方是可见按钮，不构成「藏起来却还能操作」 */
.novel-file-hidden { display: none; }
.novel-ok { color: var(--novel-ok); } .novel-err { color: var(--novel-err); } .novel-warn { color: var(--novel-warn); }
.novel-badge { font-size: var(--novel-fs-sm); white-space: nowrap; }
.novel-badge[data-status="verified"] { color: var(--novel-status-verified); }
.novel-badge[data-status="broken"] { color: var(--novel-status-broken); }
.novel-badge[data-status="unverified"] { color: var(--novel-status-unverified); }
.novel-badge-pill {
  display: inline-block; padding: 0 var(--novel-sp-2); border-radius: var(--novel-r-xs);
  margin-right: var(--novel-sp-3);
  font-size: var(--novel-fs-sm); background: var(--novel-err); color: var(--novel-on-solid);
}
/* 分组徽丸（图标态）：分组列只显示图标（hover 出全名，无图标组回退全名，
   表头「?」有图例）；flex-wrap 兜底——极多组/病态长名折行不撑破列 */
.novel-grouppill {
  display: inline-block; padding: 0 var(--novel-sp-2); border-radius: var(--novel-r-xs);
  font-size: var(--novel-fs-xs); line-height: 1.7;
  background: var(--novel-skeleton); color: var(--novel-text-2); white-space: nowrap;
}
.novel-group-legend { cursor: help; margin-left: var(--novel-sp-0); }
/* 表头「?」图例（cursor:help 是「这里有解释」的唯一提示） */
/* 圆角**不能**靠 overflow: hidden 收：行内「⋯」菜单（.novel-menu 绝对定位）的包含块
   .novel-actions 就在表内，一裁就把菜单锁进表格盒、超出表底的部分点不到（末行菜单只可见
   约 1/4，2026-09-26 用户实机）。改为首/末行各自带圆角裁自己的背景——浮层归浮层、圆角归
   圆角（判据：浮层归浮层、圆角归圆角——第二档「表格自身 overflow」翻转已实测排除）。 */
.novel-table { border: 1px solid var(--novel-border); border-radius: var(--novel-r-md);
  /* 容器查询锚：源列表按**表格自身宽度**（不是视口宽度）收列——宿主会话列可拖窄，
     视口断点在分栏布局下量不准。inline-size containment 同时把表格的布局影响范围关住。 */
  container-type: inline-size;
}
/* 圆角落在行上（表头背景 / hover 底色由行自己裁）。:only-child 写在最后——它与 :first-child
   同特异度，靠次序覆盖「一行成表」（.novel-tr.one 空态行）的四个角。 */
.novel-table > .novel-tr:first-child { border-top-left-radius: var(--novel-r-md); border-top-right-radius: var(--novel-r-md); }
.novel-table > .novel-tr:last-child { border-bottom-left-radius: var(--novel-r-md); border-bottom-right-radius: var(--novel-r-md); }
.novel-table > .novel-tr:only-child { border-radius: var(--novel-r-md); }
.novel-tr {
  display: grid; gap: var(--novel-sp-3); align-items: center;
  padding: var(--novel-sp-2) var(--novel-sp-4); font-size: var(--novel-fs-md);
  border-top: 1px solid var(--novel-border-faint);
}
.novel-tr:first-child { border-top: none; }
.novel-tr:hover { background: var(--novel-hover); }
.novel-tr.head { background: var(--novel-skeleton); font-size: var(--novel-fs-sm); color: var(--novel-text-2); }
/* 源列表六列：列宽唯一住址（表头与每一行共用，此前是两处逐字重复的字面量）。
   操作列（第5轨）**定宽 + 右对齐**（2026 调度台改版）：内容随状态增减（异常态多一个
   验证/重验钮），auto 轨让各行内容宽不一 → 右缘按钮组漂移（用户实机反馈「没对齐」）；
   定宽后「试跑/⋯」右缘全表锚定，状态动作钮向左生长。启停唯一入口 = 最右开关，
   行内不再渲染重复的「启用」文字钮。 */
.novel-tr.src { grid-template-columns: minmax(120px, 1.3fr) 68px minmax(0, 1fr) minmax(0, 1.6fr) 148px auto; }
.novel-tr.one { grid-template-columns: 1fr; }
/* 窄表收列：地址是「认得出这源」的次要线索，名称/状态/分组/操作才是要害——
   隐藏列与列轨数必须同时改（少一格配六轨 = 整行错位） */
@container (max-width: 620px) {
  .novel-tr.src { grid-template-columns: minmax(120px, 1.4fr) 68px minmax(0, 1fr) 120px auto; }
  .novel-tr.src > .col-url { display: none; }
}
/* 行级失败锚点（全局状态条的行内装饰层，transient.ts）：文案归条，行内只留红左边标记——
   错误条目的定位按钮 scrollIntoView 跳到这里，标记随错误 dismiss 消失 */
.novel-tr.row-err { box-shadow: inset 3px 0 0 var(--novel-err); }
/* 停用行：内容变灰、名称去粗体（**启停开关不参与变灰**——把开关一起压暗会读成「控件禁用」，
   而停用态恰恰是最需要能被点回来的东西）。旧实现把 opacity 行内写在四个格子上。 */
.novel-tr.off .novel-td, .novel-tr.off .novel-badge, .novel-tr.off .novel-grouppill { opacity: .6; }
.novel-tr.off strong { font-weight: 400; }
.novel-td { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.novel-td.name { display: flex; align-items: center; gap: var(--novel-sp-3); min-width: 0; }
.novel-actions { display: flex; gap: var(--novel-sp-2); justify-content: flex-end; position: relative; }
/* ── 启停开关（设置区）：状态由 aria-checked 表达，位移用 transform 而非 left
   （left 改的是布局位置，每切一次都要重排一行；transform 只走合成层）。
   旧实现把 30/17/13/15px 全写在行内 style 上，642 行每行每次渲染新建两个 style 对象。 */
.novel-switch {
  position: relative; flex: none; width: 30px; height: 17px; padding: 0;
  border-radius: 999px; cursor: pointer;
  background: var(--novel-skeleton); border: 1px solid var(--novel-border-strong);
  transition: background var(--novel-dur) var(--novel-ease), border-color var(--novel-dur) var(--novel-ease);
}
.novel-switch[aria-checked="true"] { background: var(--novel-ok); border-color: var(--novel-ok); }
.novel-switch > i {
  position: absolute; top: 1px; left: 1px; width: 13px; height: 13px; border-radius: 50%;
  background: var(--novel-text-3);
  transition: transform var(--novel-dur) var(--novel-ease), background var(--novel-dur) var(--novel-ease);
}
.novel-switch[aria-checked="true"] > i { transform: translateX(13px); background: var(--novel-on-solid); }
.novel-switch[data-busy="true"] { opacity: .55; cursor: wait; }
`
