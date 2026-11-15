/**
 * 真浏览器门的开关：起本机已装的 Edge / Chrome，量 jsdom 量不出的渲染与几何；
 * 不起服务、不访问站点、从不下载浏览器（可执行文件由 `DSH_BROWSER_EXECUTABLE` 指定，缺省自动找）。
 *
 * 主名是 `DSH_BROWSER_GATE`；历史命令里的 `DSH_EPUB_BROWSER` 仍认——这门最早只为 EPUB 阅读器
 * 而设，后来同一把闸也量配置页 / 浮层 / 听书面的几何，旧名不再描述覆盖面，但不该让写进脚本与
 * 肌肉记忆里的命令一夜失效。两个名字设任意一个都算开（值必须是 `'1'`，与其他 `DSH_*` 门同形）。
 */
export const BROWSER_GATE_ENABLED =
  process.env.DSH_BROWSER_GATE === '1' || process.env.DSH_EPUB_BROWSER === '1'