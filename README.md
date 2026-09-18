# MerMarkd

MerMarkd 是开发中的本地 Markdown 阅读与章节卡片软件。规划中的桌面应用提供源码编辑、排版阅读和按标题生成的卡片画布三种模式。

**当前状态：P0 阅读与高亮原型。** 已可打开本地 `.md`、浏览排版正文与章节目录，并把可精确定位的选文高亮保存到独立 YAML sidecar。中英文混排表格、列表和长代码行已有可滚动的阅读布局。编辑、卡片模式、便签与标签界面仍在后续批次。已完成什么、哪些能力通过实测，见[开发进度](docs/PROGRESS.md)。

## 试用阅读功能

在 Windows 上运行 `npm ci`，随后执行 `npm start`；也可执行 `npm run make`，安装 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`。点击“打开 Markdown”或按 `Ctrl+O` 选择 UTF-8 编码的 `.md` 文件。[阅读样本](tests/fixtures/reader/reading-features.md)包含目录、表格、任务列表、代码块和相对图片；[混排样本](tests/fixtures/reader/mixed-layout.md)可用于检查窄窗口的中英文表格、两位数列表和长代码行。宽表格与代码块可在各自区域内横向滚动。

可把单个 `.md` 拖到右上角“打开 Markdown”附近的区域。阅读时选中同一标题或段落中的文字，点击正文上方的一种高亮颜色；选文会着色，并在原文同目录创建 `<文件名>.md.annotations.yaml`。展开“高亮记录”可跳回原文、改色或删除；关闭重开后恢复。也可点击“检查选区定位”查看原文字节范围。`.md` 始终按只读方式载入；无法精确映射的选区会被拒绝。若源文件或 YAML 已在外部变化，应用会阻止覆盖，旧锚点只显示待定位。

支持文档目录内的相对图片和 `http`、`https`、`mailto` 外链；相对 Markdown 文档链接暂不打开。未经转换的非 UTF-8 文件会显示错误提示。当前安装包未签名，仅供本机试用。

## 项目文档

- [产品设计与技术架构](docs/PRODUCT_ARCHITECTURE.md)
- [开发流程与工程规则](docs/DEVELOPMENT_PROCESS.md)
- [可行性审查与风险门槛](docs/FEASIBILITY_REVIEW.md)
- [技术决策记录](docs/DECISIONS.md)

## 本地开发

首发开发环境为 Windows、Node.js 与 npm。执行 `npm ci` 安装锁定依赖，`npm start` 运行桌面应用，`npm test` 和 `npm run typecheck` 验证代码，`npm run make` 生成本地 Windows 测试安装包。若 Electron 下载因 GitHub 超时，可在执行构建的同一终端设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后重试。最新验证结果以进度记录为准。
