# Issue tracker: GitHub

本仓的 issue 与 spec 住在 GitHub Issues。所有操作走 `gh` CLI。

## 约定

- **建 issue**：`gh issue create --title "..." --body "..."`，多行 body 用 heredoc。
- **读 issue**：`gh issue view <number> --comments`，评论用 `jq` 过滤，并取回 labels。
- **列 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label`、`--state`。
- **评论**：`gh issue comment <number> --body "..."`
- **加/去标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

仓库从 `git remote -v` 推断；在 clone 内运行时 `gh` 自动这么做。

## Pull requests as a triage surface

**PRs as a request surface: no.** 外部 PR 不作为功能请求入口；功能请求走 Issue。GitHub 的 issue 与 PR 共用一个编号空间，裸 `#42` 可能是两者之一：先 `gh pr view 42`，失败再 `gh issue view 42`。

## 技能说「publish to the issue tracker」时

建一个 GitHub issue。

## 技能说「fetch the relevant ticket」时

跑 `gh issue view <number> --comments`。
