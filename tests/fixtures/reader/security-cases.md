# 阅读安全样本

本文件只用于检查 Markdown 阅读模式对不可信内容的处理。下面的文本不得触发弹窗、脚本、任意本地文件读取或应用内导航。

## 原始 HTML

<script>window.alert('MerMarkd security fixture')</script>

<img src="missing.png" onerror="window.alert('MerMarkd image event')" alt="不可执行的 HTML 图片">

## 链接协议

[JavaScript 链接，不应打开](javascript:window.alert('MerMarkd link'))

[data 链接，不应打开](data:text/html,%3Cscript%3Ealert(1)%3C%2Fscript%3E)

[同目录相对文档](./reading-features.md)

## 越界图片

下面的路径用于检查目录边界。阅读器不得借它读取当前文档目录以外的文件。

![越界资源应被拒绝](../../../../Windows/win.ini)
