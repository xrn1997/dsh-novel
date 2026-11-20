/** 插件页「运行参数」块（`NOVEL_CSS` 的第 10 块）：一张卡、一条列表，工具条与保存条常驻。
 *  版式理由住 `config-groups.ts` 的分区表：一列下来，每行只有「标签 | 输入框」两条轴。 */
export const CONFIG_PAGE_CSS = `
/* ── 插件页「运行参数」（config-page）─────────────────────────────────────
   形状就是这一页的可读性本身，所以钉在样式层而不是视图行内：
     · 每个字段只有一条 30px 的框：左边值、右边框内后缀（单位 / 人话回读 / 预设下拉）。
       预设不再铺一排 chip——chip 占一整行高度，且预设一多就换行。
     · 说明默认收起，聚焦、已覆盖或非法时才展开：十几行说明就是十几行高度。
     · 工具条（筛选 / 分区 / 仅看已改 / 改动计数）贴卡片顶边，保存条贴卡片底边：
       一个保存钮不再意味着「必须滚回列表底部」。 */
.novel-cfg { container-type: inline-size; display: flex; flex-direction: column; gap: var(--novel-sp-4); }
.novel-cfg-title h3 { margin: 0; font-size: var(--novel-fs-lg); font-weight: 600; }
.novel-cfg-title p { margin: var(--novel-sp-1) 0 0; font-size: var(--novel-fs-sm); color: var(--novel-text-3); }
.novel-cfg-card {
  border: 1px solid var(--novel-border); border-radius: var(--novel-r-md);
  background: var(--novel-layer-2);
}
/* 工具条：筛选框（右端是分区选择器）+ 仅看已改 + 改动计数。 */
.novel-cfg-toolbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; gap: var(--novel-sp-3);
  padding: var(--novel-sp-3) var(--novel-sp-5);
  border-bottom: 1px solid var(--novel-border-faint);
  background: var(--novel-layer-2); border-radius: var(--novel-r-md) var(--novel-r-md) 0 0;
}
.novel-cfg-filter {
  position: relative; flex: 1 1 auto; min-width: 0;
  display: flex; align-items: center; gap: var(--novel-sp-2); height: 30px;
  padding: 0 4px 0 var(--novel-sp-3);
  border: 1px solid var(--novel-border); border-radius: var(--novel-r-sm); background: var(--novel-layer-1);
  color: var(--novel-text-3);
}
.novel-cfg-search { font-size: var(--novel-fs-sm); }
.novel-cfg-searchinput {
  flex: 1 1 auto; min-width: 0; padding: 0; border: none; outline: none; background: none;
  font: inherit; font-size: var(--novel-fs-sm); color: var(--novel-text);
}
.novel-cfg-searchinput::placeholder { color: var(--novel-text-3); }
.novel-cfg-clear {
  flex: none; width: 20px; height: 20px; padding: 0; border: none; border-radius: 50%;
  background: none; color: var(--novel-text-3); font: inherit; font-size: var(--novel-fs-sm); cursor: pointer;
}
.novel-cfg-clear:hover { background: var(--novel-hover); color: var(--novel-text); }
.novel-cfg-kbd {
  flex: none; padding: 0 5px; border: 1px solid var(--novel-border); border-radius: var(--novel-r-xs);
  font-size: var(--novel-fs-xs); line-height: 16px; color: var(--novel-text-3);
}
.novel-cfg-section {
  flex: none; display: inline-flex; align-items: center; gap: 5px; height: 24px; margin-left: 2px;
  padding: 0 var(--novel-sp-2); border: none; border-left: 1px solid var(--novel-border-faint);
  background: none; color: var(--novel-text-2); font: inherit; font-size: var(--novel-fs-xs); cursor: pointer;
}
.novel-cfg-section:hover { color: var(--novel-text); }
.novel-cfg-section:disabled { cursor: default; opacity: .55; }
.novel-cfg-caret { font-size: 9px; opacity: .85; }
.novel-cfg-only {
  flex: none; height: 24px; padding: 0 var(--novel-sp-3); border: 1px solid transparent;
  border-radius: var(--novel-r-xs); background: none; color: var(--novel-text-3);
  font: inherit; font-size: var(--novel-fs-xs); cursor: pointer; white-space: nowrap;
}
.novel-cfg-only:hover { color: var(--novel-text-2); }
.novel-cfg-only.on {
  color: var(--novel-brand-strong); border-color: var(--novel-brand-line); background: var(--novel-brand-tint);
}
.novel-cfg-changed { flex: none; font-size: var(--novel-fs-xs); color: var(--novel-text-3); white-space: nowrap; }
.novel-cfg-changed.on, .novel-cfg-savedirty.on { color: var(--novel-brand-strong); }
.novel-cfg-grow { flex: 1 1 auto; }
/* 浮层：分区列表 / 命中项 / 预设，同一套外观。 */
.novel-cfg-menu {
  position: absolute; z-index: 30; top: 33px; min-width: 150px;
  display: flex; flex-direction: column; padding: var(--novel-sp-1);
  border: 1px solid var(--novel-border-strong); border-radius: var(--novel-r-md);
  background: var(--novel-layer-3); box-shadow: var(--novel-shadow-pop);
}
.novel-cfg-menu-preset { left: auto; right: -1px; }
.novel-cfg-menu-section { left: auto; right: 0; min-width: 200px; }
.novel-cfg-menu-results { left: 0; right: 0; }
.novel-cfg-menu-item {
  display: flex; align-items: center; gap: var(--novel-sp-2); padding: 5px var(--novel-sp-3);
  border: none; border-radius: var(--novel-r-xs); background: none; color: var(--novel-text-2);
  font: inherit; font-size: var(--novel-fs-sm); text-align: left; cursor: pointer;
}
.novel-cfg-menu-item:hover { background: var(--novel-hover); }
.novel-cfg-menu-item.on { color: var(--novel-brand-strong); }
.novel-cfg-menu-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.novel-cfg-menu-count { margin-left: auto; font-size: var(--novel-fs-xs); color: var(--novel-text-3); }
.novel-cfg-menu-value {
  flex: none; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--novel-fs-xs); color: var(--novel-text-3);
}
.novel-cfg-check { flex: none; font-size: var(--novel-fs-xs); }
.novel-cfg-menu-note {
  display: flex; justify-content: space-between; gap: var(--novel-sp-2);
  margin-top: 2px; padding: 5px var(--novel-sp-3); border-top: 1px solid var(--novel-border-faint);
  font-size: var(--novel-fs-xs); color: var(--novel-text-3);
}
/* 列表：分区标题 + 两列字段。 */
.novel-cfg-list { display: flex; flex-direction: column; padding: var(--novel-sp-1) var(--novel-sp-5) 2px; }
.novel-cfg-group { display: flex; flex-direction: column; }
.novel-cfg-grouphead {
  display: flex; align-items: center; gap: var(--novel-sp-2); align-self: flex-start;
  margin: var(--novel-sp-4) 0 var(--novel-sp-1); padding: 0;
  border: none; background: none; color: var(--novel-text-2);
  font: inherit; font-size: var(--novel-fs-sm); font-weight: 600; cursor: pointer;
}
.novel-cfg-grouphead:hover { color: var(--novel-text); }
.novel-cfg-chev { width: 10px; font-size: 10px; color: var(--novel-text-3); }
.novel-cfg-groupname { font-size: var(--novel-fs-sm); }
.novel-cfg-cols { display: grid; grid-template-columns: 1fr 1fr; column-gap: var(--novel-sp-6); }
/* 一行：标签 | 输入框（值 + 框内后缀）；说明与报错横跨两列。 */
.novel-cfg-row {
  position: relative; display: grid; grid-template-columns: 160px minmax(0, 1fr);
  column-gap: var(--novel-sp-3); row-gap: 3px; align-items: start;
  padding: 3px var(--novel-sp-2); margin: 0 calc(var(--novel-sp-2) * -1);
  border-radius: var(--novel-r-sm); min-width: 0;
}
.novel-cfg-row.span2 { grid-column: 1 / -1; }
.novel-cfg-row:focus-within { background: var(--novel-brand-tint); }
.novel-cfg-label {
  display: flex; align-items: center; gap: 4px; min-width: 0; height: 30px;
  font-size: var(--novel-fs-base); font-weight: 600;
}
.novel-cfg-label-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
/* 已覆盖 = 空心点（盘上的用户层）；有未保存草稿 = 实心点。两者都只占一个点，不挤标签。 */
.novel-cfg-od { flex: none; width: 6px; height: 6px; border-radius: 50%; border: 1px solid var(--novel-brand-strong); }
.novel-cfg-dot { flex: none; width: 5px; height: 5px; border-radius: 50%; background: var(--novel-brand-strong); }
.novel-cfg-field {
  position: relative; display: flex; align-items: center; gap: var(--novel-sp-2); height: 30px; min-width: 0;
  padding: 0 var(--novel-sp-2) 0 var(--novel-sp-3);
  border: 1px solid var(--novel-border); border-radius: var(--novel-r-sm); background: var(--novel-layer-1);
}
.novel-cfg-field:focus-within { border-color: var(--novel-brand); }
.novel-cfg-input {
  flex: 1 1 auto; min-width: 0; padding: 0; border: none; outline: none; background: none;
  font: inherit; font-size: var(--novel-fs-base); color: var(--novel-text);
}
.novel-cfg-input::placeholder { color: var(--novel-text-3); }
.novel-cfg-input[aria-invalid='true'] { color: var(--novel-err); }
.novel-cfg-unit { flex: none; font-size: var(--novel-fs-xs); color: var(--novel-text-3); }
.novel-cfg-hint, .novel-cfg-read { flex: none; font-size: var(--novel-fs-xs); color: var(--novel-brand-strong); white-space: nowrap; }
.novel-cfg-preset {
  flex: none; display: inline-flex; align-items: center; gap: 5px;
  padding: 0 0 0 var(--novel-sp-2); border: none; border-left: 1px solid var(--novel-border-faint);
  background: none; color: var(--novel-brand-strong); font: inherit; cursor: pointer;
}
.novel-cfg-preset:disabled { cursor: default; opacity: .6; }
/* 说明行：默认收起（display:none），:focus-within 或 .on（已覆盖 / 非法）时展开。 */
/* 说明挂在问号上：气泡绝对定位、默认 display:none，悬浮或聚焦才出现——不参与布局，行高不变。 */
.novel-cfg-tipwrap { position: relative; display: inline-flex; flex: none; }
.novel-cfg-q {
  display: inline-flex; align-items: center; justify-content: center;
  width: 13px; height: 13px; padding: 0; border: 1px solid var(--novel-border); border-radius: 50%;
  background: none; color: var(--novel-text-3); font: inherit; font-size: 9px; line-height: 1; cursor: help;
}
.novel-cfg-q:hover, .novel-cfg-q:focus-visible { color: var(--novel-text-2); border-color: var(--novel-border-strong); }
.novel-cfg-bubble {
  position: absolute; z-index: 40; top: 20px; left: -4px; width: 260px; display: none;
  padding: var(--novel-sp-2) var(--novel-sp-3);
  border: 1px solid var(--novel-border-strong); border-radius: var(--novel-r-sm);
  background: var(--novel-layer-3); color: var(--novel-text-2);
  font-size: var(--novel-fs-xs); font-weight: 400; line-height: 1.6;
  box-shadow: var(--novel-shadow-pop); white-space: normal;
}
.novel-cfg-tipwrap:hover .novel-cfg-bubble, .novel-cfg-tipwrap:focus-within .novel-cfg-bubble { display: block; }
.novel-cfg-reset {
  flex: none; width: 13px; height: 13px; padding: 0; border: none; background: none;
  color: var(--novel-text-3); font: inherit; font-size: var(--novel-fs-xs); line-height: 1; cursor: pointer;
}
.novel-cfg-reset:hover { color: var(--novel-text-2); }
.novel-cfg-reset:disabled { cursor: default; opacity: .5; }
.novel-cfg-err { grid-column: 1 / -1; margin: 0; font-size: var(--novel-fs-sm); color: var(--novel-err); }
/* 听书段的对象数据管理区：默认收成一行（引擎清单是网络读面，展开才读到）。 */
.novel-cfg-manager { display: flex; flex-direction: column; }
.novel-cfg-managerhead { margin-top: var(--novel-sp-3); }
/* 保存条：贴卡片底边常驻，带改动计数与快捷键。吸附位置要落在滚动区的**可视底边**：
   --novel-cfg-pin 由 watchSavebarPin 在第一次吸住时写入（宿主页把底部留白做在滚动容器的
   padding 里，Chromium 系引擎的 sticky 以内容盒为界，不补就会停在内边距之上、条下露出列表尾部）。 */
.novel-cfg-savebar {
  position: sticky; bottom: var(--novel-cfg-pin, 0px); display: flex; align-items: center; gap: var(--novel-sp-2);
  padding: var(--novel-sp-3) var(--novel-sp-5);
  border-top: 1px solid var(--novel-border-faint); background: var(--novel-layer-2);
  border-radius: 0 0 var(--novel-r-md) var(--novel-r-md);
}
.novel-cfg-savedirty { font-size: var(--novel-fs-xs); color: var(--novel-text-3); white-space: nowrap; }
.novel-cfg-foot { margin: var(--novel-sp-3) 0 0; padding: 0 var(--novel-sp-5); font-size: var(--novel-fs-sm); line-height: 1.6; color: var(--novel-text-3); }
.novel-cfg-foot code { font-family: ui-monospace, Consolas, monospace; font-size: var(--novel-fs-xs); }
.novel-cfg-empty { margin: var(--novel-sp-5) var(--novel-sp-5); }
.novel-cfg-note { margin: 0; padding: 0 var(--novel-sp-5) var(--novel-sp-3); font-size: var(--novel-fs-sm); line-height: 1.6; color: var(--novel-text-3); }
.novel-cfg-note[role='alert'] { color: var(--novel-err); }
.novel-cfg-mono { margin-left: var(--novel-sp-2); font-family: ui-monospace, Consolas, monospace; font-size: var(--novel-fs-xs); }
/* 窄档（卡片自身不足 560px）：两列折成一列，行内“标签在上、输入在下”。 */
@container (max-width: 560px) {
  .novel-cfg-cols { grid-template-columns: minmax(0, 1fr); }
  .novel-cfg-row { grid-template-columns: minmax(0, 1fr); }
  .novel-cfg-label { height: auto; }
  .novel-cfg-toolbar { flex-wrap: wrap; }
}
`