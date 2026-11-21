# legado 的这些面整块不接（显式说不，逐条给理由的行在矩阵里）

Status: accepted

「不适用」不写下来就和「忘了做」「不知道」长得一样。这份清单只收**整面级**裁决——字段级的已有家（矩阵行 `note`，`status-evidence` 强制写理由），这里不重复。不接：评论与段评（`ruleReview` 没有本仓能声明的活读法）；配置 / 界面 / 真实文件 / 压缩包这类安卓宿主能力（真浏览器 WebView 已接，`androidId` 用数据根 `device-id` 的稳定 UUID 承接；认不出的宿主调用如实抛「需要安卓宿主环境」，纯 UI 副作用是 no-op）；字体反混淆（要先下载并解析字体文件，本仓不开文件下载面）；加密/签名的加密侧（只实现解密面，非对称签名不做；摘要与 HMAC 族已实现）；旧书源一次性迁移与规则编辑器补全；源级代理路由（本仓代理是进程级判定，出站口只有守门 fetcher 一处）；RSS / 音频 / 图片 / 文件类源（闸在入库 normalize 处点名拒绝）；书籍类型位标志、`respondTime` 排序轴、目录整本倒序开关（分别由单值 type + 参与集谓词、导入序 + 待办置顶、链首 `-` 前缀承担）；分支独有的模块面（推荐 / 主页模块 / 自定义按钮 / 高亮取词）；书籍更新检测整链；跨源搜索合并/归并（搜索面已裁：默认按书归并、逐源轴降级为页尾折叠，`ADR-0033`；作品级身份与进度搬运仍待裁，要一并裁章名对齐、缺章、付费章与 `bookKey` 是否升格）。判完不接不等于销案：矩阵行必须存在、状态 `not-applicable` 且 `note` 写明理由；已接或已开口的面按矩阵状态（`implemented` / `open`）为准，不套 `not-applicable`。

锚点：`tests/legado-coverage/matrix.ts`（`j-review`、`c-review-url`、`h-android-packages`、`b-opt-webview`、`h-java-android-id`、`h-file-extra-apis`、`h-font-anti-scrape`、`h-encrypt-side`、`a-legacy-2x-migration`、`i-rule-complete`、`b-proxy-per-source`、`j-rss`、`j-audio-image-file`、`d-book-type-constants`、`d-respond-time-inflation`、`f-toc-reverse-twice`、`c-related-books`、`i-highlight-rule`、`c-pre-update-js`、`e-can-re-read`）；`src/services/normalize.ts` 的 `contentTypeOfRaw`；`src/services/proxy.ts`；`ADR-0033`。
