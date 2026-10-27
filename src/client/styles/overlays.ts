/** 浮层块（`NOVEL_CSS` 的第 8 块）：模态确认、状态条泳道、导入区，以及指针与动效偏好
 *  （hover-only 的 affordance 必须有非 hover 的路）。 */
export const OVERLAYS_CSS = `
/* ── 模态确认（删除书籍等危险操作）：遮罩 + 居中对话框 + 危险色确认钮；
   Esc / 点遮罩取消，失败留在框内可重试（错误不再散落在页面流里）。── */
.novel-modal-mask {
  position: fixed; inset: 0; z-index: var(--novel-z-modal); display: grid; place-items: center;
  background: var(--novel-mask); padding: var(--novel-sp-5);
  animation: novel-fade var(--novel-dur) var(--novel-ease);
}
.novel-modal {
  width: min(400px, calc(100vw - 48px)); background: var(--novel-layer-2);
  border: 1px solid var(--novel-border); border-radius: var(--novel-r-lg);
  padding: var(--novel-sp-5) var(--novel-sp-6);
  box-shadow: var(--novel-shadow-pop);
  display: flex; flex-direction: column; gap: var(--novel-sp-4);
  animation: novel-rise var(--novel-dur) var(--novel-ease);
}
.novel-modal-title { font-size: var(--novel-fs-base); font-weight: 600; line-height: 1.5; }
/* 导入弹层等信息量更大的模态用宽档（删除确认保持 400px 紧凑档） */
.novel-modal.wide { width: min(680px, calc(100vw - 48px)); }
.novel-modal-body { font-size: var(--novel-fs-md); color: var(--novel-text-2); line-height: 1.6; }
.novel-modal-warn { font-size: var(--novel-fs-sm); color: var(--novel-warn); line-height: 1.6; }
.novel-modal-actions { display: flex; justify-content: flex-end; gap: var(--novel-sp-3); margin-top: var(--novel-sp-1); }
.novel-btn.danger.solid { background: var(--novel-err); border-color: var(--novel-err); color: var(--novel-on-solid); }
.novel-btn.danger.solid:hover { filter: brightness(1.08); background: var(--novel-err); }
@keyframes novel-fade { from { opacity: 0; } }
@keyframes novel-rise { from { opacity: 0; transform: translateY(6px) scale(.98); } }
/* ── 状态条泳道：栏位形状由类给出（不要在渲染时用工厂造 style 对象）── */
.novel-lane {
  display: grid; gap: var(--novel-sp-3); align-items: center; width: 100%; text-align: left;
  border: none; padding: var(--novel-sp-1) var(--novel-sp-4);
  font: inherit; font-size: var(--novel-fs-sm); cursor: pointer; background: transparent; color: inherit;
}
.novel-lane.cols-1 { grid-template-columns: 1fr; cursor: default; }
.novel-lane.cols-err { grid-template-columns: auto 1fr auto auto; background: var(--novel-err-weak); }
.novel-lane.cols-job { grid-template-columns: auto auto 1fr auto; }
.novel-lane-link { color: var(--novel-brand); white-space: nowrap; }
/* ── 导入区：拖放主入口（dragging/busy 两态由类给，视图只切类名）+ 粘贴小道 + 完成汇总 ── */
.novel-dropzone {
  display: flex; flex-direction: column; gap: var(--novel-sp-1);
  border: 1.5px dashed var(--novel-border-strong); border-radius: var(--novel-r-md);
  padding: var(--novel-sp-6) var(--novel-sp-5); text-align: center; cursor: pointer;
  background: var(--novel-layer-2);
  transition: border-color var(--novel-dur) var(--novel-ease), background var(--novel-dur) var(--novel-ease);
}
.novel-dropzone:hover { border-color: var(--novel-brand); }
.novel-dropzone.dragging { border-color: var(--novel-brand); background: color-mix(in srgb, var(--novel-brand) 6%, transparent); }
.novel-dropzone.busy { cursor: default; opacity: .45; }
.novel-dropzone:focus-visible { outline: 2px solid var(--novel-ring); outline-offset: 2px; }
.novel-dropzone-icon { font-size: 22px; line-height: 1; }
.novel-dropzone-lead { font-size: var(--novel-fs-base); margin-top: var(--novel-sp-2); }
.novel-paste { border: 1px solid var(--novel-border); border-radius: var(--novel-r-md); background: var(--novel-layer-2); }
.novel-paste > summary { color: var(--novel-text-2); }
.novel-paste-body { padding: var(--novel-sp-0) var(--novel-sp-4) var(--novel-sp-4); gap: var(--novel-sp-3); }
/* 导入汇总条：左侧 3px 竖条说成败（整块刷色会把「读一段文字」变成「盯一面红墙」） */
.novel-result { border-left: 3px solid var(--novel-ok); }
.novel-result.err { border-left-color: var(--novel-err); }
.novel-issues { margin-top: var(--novel-sp-2); }
/* ── 指针与动效偏好：hover-only 的 affordance 必须有非 hover 的路 ── */
@media (hover: none) {
  .novel-card-x { opacity: 1; }
  .novel-card:hover, .novel-card:focus-visible { transform: none; box-shadow: none; }
}
@media (prefers-reduced-motion: reduce) {
  .novel-card, .novel-btn, .novel-chip, .novel-seg button, .novel-searchbox, .novel-row,
  .novel-book-chev,
  .novel-city-card, .novel-city-kind,
  .novel-switch, .novel-switch > i, .novel-progress > i, .novel-rdr-trail::after, .novel-rdr-ctl,
  .novel-card-ghost .novel-ghost-cover {
    transition: none;
  }
  .novel-sk::after { animation: none; }
  .novel-modal-mask, .novel-modal { animation: none; }
  .novel-card:hover, .novel-card:focus-visible { transform: none; }
}
`
