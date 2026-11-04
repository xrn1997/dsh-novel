# legado 的这些面整块不接（显式说不，逐条给理由的行在矩阵里）

Status: accepted

「不适用」不写下来就和「忘了做」「不知道」长得一模一样。这份清单只收**整面级**的裁决——单个字段级的不适用已经有家（矩阵行 `note`，且 `status-evidence` 强制它写明理由），这里不重复。

- **评论与段评面**：本仓不接——`ruleReview` 没有本仓能声明的活读法，评论内容也不是连续滚动文字阅读这一产物要的；格式侧与 App 侧的现状分叉，读数住矩阵行 `j-review`、`c-review-url` 的 `note`。
- **安卓 App 宿主能力**：真浏览器 WebView 已接（矩阵 `b-opt-webview`）；`androidId` 用数据根 `device-id` 的稳定 UUID 承接（矩阵 `h-java-android-id`）。仍未接的是配置、界面、真实文件、压缩包这类宿主能力面（能力单元见矩阵 `h-android-packages`、`h-file-extra-apis`）：认不出的宿主调用如实抛「需要安卓宿主环境」；纯 UI 副作用是明确 no-op（见 `ADR-0004` 的例外）。
- **真实文件与压缩包 API、字体反混淆**：前者是数据外泄面，只给「下载 → 不透明令牌 → 读」的进程内暂存；后者要先下载并解析字体文件才能还原文字，本仓不开文件下载面，这条裁决已经覆盖它。
- **加密/签名的加密侧**：只实现解密面。书源里的加密与签名服务于「造请求」；非对称签名族不做——自签自验证明不了与真正验签的对端互通，做错比不做更糟。边界：摘要与 HMAC 族**不在本裁决**，已实现。
- **旧书源格式的一次性迁移、规则编辑器侧的补全**：前者是一次性升级工具——本仓没有需要被迁移的存量库存；后者是编辑期元数据——本仓没有规则编辑器。旧格式形态的分母见矩阵行 `a-legacy-2x-migration`。
- **源级代理路由**：本仓代理是**进程级判定**（config > env > 系统代理 > 直连），出站口只有守门 fetcher 一处；源级代理等于把网络出口分散到不可审的粒度。
- **RSS 订阅源、音频/图片/文件类源**：产物是连续滚动文字阅读 + 文本工具；这些媒介各有独立读源与 UI，且误标 text 会成片污染聚合搜索与书架——所以闸在入库 normalize 处**点名拒绝**，不是读不懂当文本。
- **书籍类型位标志体系、`respondTime` 排序轴、目录整本倒序开关**：分别由单值 type + 一个参与集谓词、导入序 + 待办置顶、链首 `-` 前缀承担同一职责，位标志组合没有消费方。
- **分支独有的模块面**（相关推荐、主页模块、自定义按钮、高亮取词）：兼容判据的分母是矩阵登记的能力单元与现库读数（`ADR-0054`）——分支特有的新增天然不在分母里；逐条能力单元的落点在矩阵行 `c-related-books`、`i-highlight-rule`。
- **书籍更新检测整链**：本仓没有追更与版本比对链路。
- **跨源搜索合并/归并**：搜索面已裁——默认按书归并、逐源轴降级为页尾折叠，见 `ADR-0033`；源好坏没有从界面上消失，只是从默认视野挪到了排查轴。作品级身份与进度搬运（「换源」）仍待裁：要一并裁章名对齐、缺章、付费章与 `bookKey` 是否升格。

判完不接不等于销案：矩阵里那一行必须存在、状态必须是 `not-applicable` 且 `note` 写明理由——「格式带了那个键，但本仓没有承载它的交互或可配字段」那一族（`checkKey` / `canReRead` / `addUrlRule` 等）登记在册的目的正是防止以后把「用不上」当成「我们该补」。已接或已开口的面按矩阵状态（`implemented` / `open`）为准，不套 `not-applicable`。

锚点：`tests/legado-coverage/matrix.ts`（按行 id 查：`j-review`、`c-review-url`、`h-android-packages`、`b-opt-webview`、`h-java-android-id`、`h-file-extra-apis`、`h-font-anti-scrape`、`h-encrypt-side`、`a-legacy-2x-migration`、`i-rule-complete`、`b-proxy-per-source`、`j-rss`、`j-audio-image-file`、`d-book-type-constants`、`d-respond-time-inflation`、`f-toc-reverse-twice`、`c-related-books`、`i-highlight-rule`、`c-pre-update-js`、`e-can-re-read`）；`src/services/normalize.ts` 的 `contentTypeOfRaw`；`src/services/proxy.ts`；`ADR-0033`。
