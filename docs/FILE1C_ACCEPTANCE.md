# FILE1C 文档与本地图片副本包验收

2026-11-19。基线为已合并 PR #24 的 main `d584144`，分支 `codex/file1c-document-bundle`。本批提供 ZIP 文档副本包，保留原文件名、相对图片路径及全部内容字节；不改写 Markdown 或重算锚点，不将其他本地文档递归打包。

## 用户步骤与范围

文档菜单新增「打包文档与本地图片…」。选择新的 ZIP 名称后，检查已保存正文、现有批注 / 画布及直接引用的图片，显示目的位置、实际文件和图片数量、总内容大小及最多八项文件名；包含已有批注与便签会明确说明。确认才写出，默认取消，原文、模式和最近文件保持。

ZIP 包含原 Markdown 文件名及实际存在的两个 sidecar，并按原相对路径放入目录内的 PNG、JPG/JPEG、GIF、WebP 图片。重复路径只收一份。一次 URI 解码支持中文、空格和 emoji，源码地址本身不变。代码 / YAML 字面路径不作为图片；网络地址和页内锚点保留，不下载网络资源，也不宣称含网络引用的包离线完整。

全部链接、图片和引用定义参与计划。目录外路径、`.` / `..`、绝对地址、反斜杠、未知协议、含查询或片段的本地目标、Windows 非法 / 保留名称、大小写或 Unicode 等价冲突、其他本地文件、HTML 与已知未支持扩展均拒绝。只收明确的直接图片，不跟随其他 Markdown、HTML 或图片内部的额外资源。图片须是普通文件，拒绝 symlink / junction、缺失文件及扩展与文件头不符的输入。

上限为 32 张去重图片、每图 10 MiB、全部内容 50 MiB；正文 32 MiB、批注 1 MiB、画布 4 MiB 上限保持。采用 UTF-8、stored ZIP32，不压缩、不新增依赖，不主动修改原文件权限或时间戳，核验内容字节和 mtime 保持。

## 发布和数据边界

无参数 preload API 由受信主 frame 的当前会话拥有，ZIP 位置仅来自 main 原生选择。dirty、表单、组合及待提交输入、原文事务与在途操作继续冻结。预览使用已捕获快照；确认后重新核验正文、两个 sidecar、所有图片及目的目录身份，外部变化拒绝并保留。

完整 ZIP 同步到目的目录唯一私有临时文件后，独占硬链接发布单个新文件。任何已有 ZIP 不覆盖，任何已发布 ZIP 不删除；失败只清理能够核验身份和摘要的自有暂存。单文件发布不新增三文件 journal。进程中断后可能留下未发布暂存，或已经完整发布的 ZIP；不承诺目录 fsync、物理断电持久性或任意外部进程竞态的原子保证。原文和图片始终只读。

## 退出条件

- [x] 原始引用计划与路径边界测试。
- [x] ZIP 编码、CRC / UTF-8、文件快照、外部变化、目录替换、取消和中断测试。
- [x] 类型检查、完整单测、干净 npm ci 和 Windows make。
- [x] 最终包专项及外部 .NET ZIP 解压兼容性，解压文档图片 / 批注 / 画布重开。
- [x] 既有完整窗口回归、实际 Vite、窄窗与截图复核。
- [ ] 同包证据、原失败、用户三文件摘要及 GitHub 回执。

原生确认响应由隔离 main 模拟，窗口测试使用生成的临时文档和绝对隔离 profile。本批不新增真实输入法、辅助客户端、正式性能、安装生命周期、物理跨屏或跨物理卷验收，FILE1 / QA1 / P0 尚未整体退出。

## 最终包验证

运行时 `945c0f5` 在全新 detached worktree 完成 `npm ci`、`npm run typecheck`、`npm test`（421/421）及 `npm run make`。核心规划 18 项、store 24 项，新增共 42 项单测；ZIP 条目 CRC 使用 Node 原生 zlib 校验，准备 / 发布两阶段真实子进程退出 73 分别留下无公开输出或完整 ZIP，原文和图片保持。源检出 clean、锁文件、主工作区 index 与冻结 QA1 产物均保持。

ASAR 4,108,677 字节，SHA-256 `DB1ACDC9C189E4998C9C0F61D573A268B7868F95F25FDCFE1EF26616CDDB3A7C`；Setup 154,849,792 字节，SHA-256 `4A267BBAC3555D2281022A32EF2850EFE36B9EC99B74BBF6FE8FD939FB18BCD0`。安装包仅在本地生成，没有执行安装或公开发布。

同包 `file1c-final-a-regression-manifest.json` 的 34 套窗口全部通过。FILE1C 十项专项包括真实菜单打包、保存 / 确认取消零写入、未知和越界引用拒绝、缺失 / 坏头图片、确认期间 MD / YAML / 图片外部变化保留、目标 ZIP 已存在、缺失 / 非法 sidecar、dirty 输入保留与 420 px 实际创建。

ZIP 经现有 `pwsh.exe` 宿主调用 `System.IO.Compression.ZipFile` 独立解压，中文 / 空格 / emoji 条目与 percent 编码引用保持，解压后的原 MD / sidecar / 图片逐字节相同。应用按真实最近文档 path 确认打开解压文档，图片实际解码、旧 basis / 待定位、标签、折叠与箭头重开通过；修改解压副本不影响原文。窄窗菜单和解压画布截图已视觉复核。脚本使用既有 RemoteSigned 宿主，没有修改执行策略或使用 Bypass。

文件 symlink 子项因 OS 权限未执行，已在单测日志输出诊断；目录 junction 子项确已执行并通过，不能把外层通过等同全部子项实测。图片只做格式头核验，完整解码证据限本次 PNG 样本。单机不同目录不等同不同物理卷验收。

复现入口：`npm run typecheck`、`npm test`、`npm run make`、`npm run test:e2e:file1c`。专项支持 `MERMARKD_QA_EXE`、`MERMARKD_QA_RENDERER_URL`、`MERMARKD_QA_ARTIFACT_PREFIX`；外部解压宿主可用 `MERMARKD_QA_POWERSHELL` 指定现有可用 PowerShell。生成测试数据和绝对隔离 profile 不包含用户真实文档。
## 开发模式与收口

同一运行时代码 `945c0f5` 的实际 Vite FILE1C / FILE1B / FILE1A / UX9 / UX8 / UX7 六套全部通过，记录 `file1c-final-vite-a-manifest.json`；5178 服务与候选窗口均已停止。本批最终包 34 套及 Vite 六套没有重试或覆盖失败结果。独立 .NET 解压证据在打包和开发两种模式均完成。

汇总见 [FILE1C_EVIDENCE.json](FILE1C_EVIDENCE.json)，包含构建身份、测试命令 / 日志摘要、十项副本包专项及已知环境边界。三项用户原文件 SHA-256 均保持，且未纳入提交。README 已补充解压后打开原 Markdown 的步骤，并纠正旧的仅阅读模式描述。

本批本机软件退出条件通过，GitHub 回执在交付后补齐。后续可单独评估应用内导入、更多附件与安全可证明的引用范围，不将本批称为任意工作区或网络内容的完整离线包。