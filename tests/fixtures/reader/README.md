# 阅读模式手工验收样本

用软件依次打开 `reading-features.md` 和 `security-cases.md`。这些文件只用于验收，不应被软件修改。

## 本批次的主要检查

1. 打开 `reading-features.md`，确认前言、各级标题、粗斜体、列表、任务列表、表格、代码围栏和引用块按 Markdown 显示。
2. 目录只列出文档根层标题；代码围栏和引用块中的 `#` 不应变成目录项。点击目录中的“后续章节”和“Setext 二级标题”，应定位到对应正文。
3. 首次打开和目录跳转前后，可在 PowerShell 中对原文件执行 `Get-FileHash .\tests\fixtures\reader\reading-features.md -Algorithm SHA256`，两次摘要应相同。不得生成旁边的画布数据文件。
4. 打开 `security-cases.md`，确认原始 HTML 和危险链接不会执行脚本或打开应用内的新页面。越界图片不得读取文档目录外的文件。

相对本地 PNG 图片用于检查资源处理。若当前最小阅读切片尚未支持本地图片，应清楚显示无法加载；不应为了显示图片扩大任意文件读取权限。图片可在后续切片完善。
