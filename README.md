# MerMarkd

MerMarkd 是开发中的本地 Markdown 阅读与章节卡片软件。规划中的桌面应用提供源码编辑、排版阅读和按标题生成的卡片画布三种模式。

**当前状态：P0 阅读、批注持久化与混排排版原型。** 已可打开本地 `.md`、浏览排版正文与章节目录，并将验证过的选区测试锚点保存到独立 YAML sidecar。中英文混排表格、列表和长代码行已有可滚动的阅读布局。编辑、卡片模式、正文高亮着色和便签界面仍在后续批次。已完成什么、哪些能力通过实测，见[开发进度](docs/PROGRESS.md)。

## 试用阅读功能

在 Windows 上运行 `npm ci`，随后执行 `npm start`；也可执行 `npm run make`，安装 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`。点击“打开 Markdown”或按 `Ctrl+O` 选择 UTF-8 编码的 `.md` 文件。[阅读样本](tests/fixtures/reader/reading-features.md)包含目录、表格、任务列表、代码块和相对图片；[混排样本](tests/fixtures/reader/mixed-layout.md)可用于检查窄窗口的中英文表格、两位数列表和长代码行。宽表格与代码块可在各自区域内横向滚动。

可把单个 `.md` 拖到右上角“打开 Markdown”附近的区域。阅读时选中同一标题或段落中的文字，点击“验证选区”；定位成功后点击“保存测试高亮锚点”，应用会在原文同目录创建 `<文件名>.md.annotations.yaml`。关闭并重开文档后可在正文上方看到记录数。本批仅保存锚点，尚不显示彩色高亮；`.md` 始终按只读方式载入。若源文件或 YAML 已在外部变化，应用会阻止覆盖并提示待处理草稿。

支持文档目录内的相对图片和 `http`、`https`、`mailto` 外链；相对 Markdown 文档链接暂不打开。未经转换的非 UTF-8 文件会显示错误提示。当前安装包未签名，仅供本机试用。

## 项目文档

- [产品设计与技术架构](docs/PRODUCT_ARCHITECTURE.md)
- [开发流程与工程规则](docs/DEVELOPMENT_PROCESS.md)
- [可行性审查与风险门槛](docs/FEASIBILITY_REVIEW.md)
- [技术决策记录](docs/DECISIONS.md)

## 本地开发

首发开发环境为 Windows、Node.js 与 npm。执行 `npm ci` 安装锁定依赖，`npm start` 运行桌面应用，`npm test` 和 `npm run typecheck` 验证代码，`npm run make` 生成本地 Windows 测试安装包。若 Electron 下载因 GitHub 超时，可在执行构建的同一终端设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后重试。最新验证结果以进度记录为准。
