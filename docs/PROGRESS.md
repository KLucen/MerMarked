# MerMarkd 开发进度

> 2026-09-17。当前阶段：P0 可行性原型，进行中；最小阅读切片完成，等待试用反馈。状态只记录已观察到的结果；“设计可行”不等于“功能已实现”。

## 已完成

- 建立产品与架构方案 v0.2、开发流程、可行性审查与技术决策记录。
- 检查本机环境：Windows x64，Node 24.20.0、npm 11.19.0、Git 2.45.1 可用；Rust/Cargo 与 MSVC 编译工具未发现。
- 核实 Electron、Forge、CommonMark/mdast、React Flow 和导出相关官方文档，并定义 P0 验证关口。
- 初始化 Git，建立 Electron Forge + Vite + TypeScript + React 安全桌面壳和 npm 锁文件。`npm run package`、`npm run make` 通过；打包版与 Squirrel 安装版均启动并显示 MerMarkd 窗口。Windows 测试安装包位于 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`，约 154 MB。测试安装版已用官方卸载入口卸载。
- 实现 `src/core/sections.ts` 的 Markdown 根层标题抽取、章节父子树和原文 UTF-16 半开范围；已接入阅读界面目录。
- 完成最小只读阅读器：本地 `.md` 打开/取消/错误提示、UTF-8/BOM 解码、GFM 排版、YAML frontmatter 隐藏、根层章节目录与跳转、同名标题独立锚点、`Ctrl+O`、受控相对图片和外链。原始 HTML 不执行；编辑与卡片入口标明尚未开放。
- 使用打包版实测 `reading-features.md`：目录 5 个标题、表格 1 个、本地 PNG 实际宽 96 px、目录跳转后滚动并选中章节；YAML 元数据未显示。`security-cases.md` 中原始 HTML 未产生脚本或图片节点，越界图片显示失败占位。阅读前后样本 SHA-256 均为 `D5C6D8EAFD642D28C0D5852FD38DF9519913EC77666108BAB75217FAE9FF34FC`，未生成 sidecar。
- `npm test` 13/13 通过，`npm run typecheck` 通过。`npm run make` 使用 Electron 镜像后生成新版 Windows 测试安装包，位于 `out/make/squirrel.windows/x64/MerMarkd-0.1.0 Setup.exe`，约 154 MB；打包版成功启动并通过上述实际阅读检查。

## 当前停点

- 等待用户试用最小阅读切片并反馈，再进入下一批。建议下一批继续 P0-B：章节子树移动的候选文本、重解析校验、预览与拒绝规则。

## 后续切片

1. P0-B：结构变换原型，包含重新解析与不安全操作拒绝。
2. P0-C：Markdown/sidecar 一致性、恢复草稿与稳定卡片 ID 原型。
3. P0-D：嵌套画布和独立 PDF/JPG 导出原型。

## 尚未验证的门槛

- 测试安装包已生成；新版阅读切片已在打包版启动与打开文件，尚未在干净 Windows 机器或新版安装版完成安装/卸载复验。首次从 GitHub 获取 Electron 资源超时，设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后成功。前一版安装版启动时有缓存目录权限警告，UI 仍显示；卸载后 Squirrel 留下 `.dead`、`Update.exe` 和 `squirrel.exe` 残留，发布前需复测与处理。
- 章节移动、双文件恢复、ID 匹配和全图导出尚未由可运行代码验证。
- 5 MB 文档、1000 标题、200 可见卡片以及单图尺寸均只是目标，尚无测量结果。
- 阅读器目前将全文在渲染线程同步解析；大文件性能和图片解码后内存占用尚未测量。相对 `.md` 链接只提示暂不支持。

## 本轮验证命令

```powershell
npm test
npm run typecheck
npm run package
npm run make
```

`npm test`：13/13 通过；`npm run typecheck`：通过。首次 `npm run make` 因 GitHub Electron 下载超时失败；设置 `ELECTRON_MIRROR` 后重试成功。打包版经 DevTools 协议和 Windows 文件选择器实测打开、目录跳转、本地图片、安全内容与原文摘要。Node 测试会提示项目未声明 ESM 模块类型，目前不影响测试结果。
