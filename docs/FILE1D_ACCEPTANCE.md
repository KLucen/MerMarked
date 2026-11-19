# FILE1D · 在应用内打开文档副本包

2026-11-19，基于已合并 FILE1C / main `bbfae8f`。本批本机工程退出条件通过；FILE1 / QA1 / P0 尚未整体完成。证据见 [FILE1D_EVIDENCE.json](FILE1D_EVIDENCE.json)，决定见 ADR-060。

## 使用与文件边界

开始页或文件菜单选择「打开副本包…」，选择 FILE1C 生成的 ZIP。应用先只读校验整个包，再选择解包父目录，预览新文件夹、文件数、图片数、总内容字节和是否包含批注 / 便签。确认后创建一个带随机后缀的独立子目录，保持原文件名、图片路径和所有内容字节；成功才打开其中 Markdown 并记录最近文档。

已有未保存正文、批注表单和输入法组合沿用共同离开保护。取消或失败保持当前文档与模式。若用户已明确选择「保存后继续」，该保存仍是独立授权的原文写入；不能把随后取消解包说成没有发生过保存。

当前文档有未完成保存恢复时，需先处理恢复再打开包；这是本批沿用文件操作锁的保守限制。

源 ZIP 始终只读。不存在的 companion 不生成；旧 basis、待定位批注及画布身份原样保留，不为复制改写锚点。阅读 / 编辑 / 卡片加载继续使用原有版本核验。

## 受支持的包

- 仅接受 FILE1C 的 UTF-8、stored ZIP32 方言：一个根 Markdown、同名的现有批注 YAML / 画布 JSON，以及 Markdown 直接引用的 PNG / JPG / JPEG / GIF / WebP。不是通用 ZIP 解压器。
- 限制为 ZIP 52 MiB、全部内容 50 MiB、Markdown 32 MiB、YAML 1 MiB、JSON 4 MiB、最多 32 张图片且每图 10 MiB；路径最多 32 层目录、合计最多 128 个目录。
- 中央目录与本地头逐项一致，校验 CRC、偏移、长度、严格 UTF-8、文件类型与尺寸；拒绝压缩、加密、ZIP64、额外字段、注释、目录条目、重复或大小写 / NFC 别名、文件目录碰撞、设备名、绝对路径与越界路径。目录前缀拼写别名也保守拒绝。
- 重新审计 Markdown 引用，图片集合必须精确对应，核验图片文件头及现有 sidecar schema。HTML、未知扩展、目录外 / 无法确认资源、未引用附件拒绝，网络地址保留且不下载。

## 发布与失败

确认前不创建应用输出。选择的父目录和 ZIP 均核对 canonical path / 文件身份；新目录独占创建，子目录不可经过 symlink / junction。私有文件以 `wx` 创建、同步后用独占硬链接发布，图片和 companion 优先，Markdown 最后。发布 Markdown 前复核 ZIP、目录和全部已发布文件的身份与摘要；已有文件不覆盖、不删除。

本批不新增导入事务日志。原 ZIP 是完整重试来源，失败保留已经生成的新文件夹并提示位置；重试创建另一个独立目录。Markdown 在其他捕获文件发布并核验后最后发布，全部最终核验成功才打开。没有外部更改的进程中断样本在 Markdown 发布前没有入口、发布后保留完整包；Markdown 存在不能替代失败提示和完整性核验。可能遗留私有暂存，不宣称三文件原子性、目录项物理断电持久性或可恢复外部恶意持续改写。

## 验收例子与退出条件

1. 从开始页导入 BOM / CRLF、中文文件名、相对 PNG、旧基线批注和折叠 / 箭头包；原 ZIP bytes / mtime 保持，新目录与包内容逐字节一致，图片可解码，三个模式可用。
2. 从已有文档菜单导入；取消源选择、父目录和预览都保持当前文档与模式，不生成解包目录。dirty 的取消和保存后继续使用真实界面验证。
3. CRC 错误、zip-slip、schema 或引用不安全，在选择父目录前拒绝。预览后 ZIP 或目录变化拒绝，不覆盖旧文件；选择已有文件的父目录只增加新子目录。
4. 文件服务验证路径替换、junction、同名目标、外部更改、半途失败和两个真实进程中断点；失败保留发布物，重试另建目录。
5. 类型检查、全量单测、Windows make；同一冻结 ASAR 上新增 FILE1D 与全部既有打包窗口回归，实际 Vite 相关回归和 420px 布局通过。记录包摘要、命令、失败及限制，保持三项用户原修改。

原生 IME、正式性能、安装升级卸载、物理跨屏 DPI、跨物理卷和干净 Windows 不由本批测试替代。

## 实际验证与产物

- 运行时提交 `6f0beaa5efd67e876bcd8677ccebfe4620df0524` 在独立 detached 检出 `C:\Users\KLucen\.codex\worktrees\mermarkd-file1d-final` 完成 `npm ci`、`npm run typecheck`、`npm test`（460/460）及 `npm run make`。构建源 clean、lockfile、主工作区 index 和原 QA1 冻结产物均保持。Node 24.20.0 / npm 11.19.0 / Electron 44.4.1，无新依赖。
- 新增 19 项纯 core ZIP 测试和 20 项文件服务测试，包含独立 zlib CRC、FILE1C 实际 writer 往返、真实最大尺寸、截断 / 危险头与路径 / 别名 / 集合校验、父目录 / 输出目录 / junction 替换、ZIP 同字节身份替换、已发布文件外改、取消、独立重试和真实子进程退出 73。MD 发布后报错的完整目录同样保留。文件 symlink 子例因 Windows `EPERM` 未执行，目录 junction 子例实际通过。
- ASAR 4,120,372 bytes，SHA-256 `A111DD7C3A1C5FD87D26697F94D5AC091DFBC4DA1019F89BEB6C52C50316C65E`。Setup 154,852,864 bytes，SHA-256 `DDBF0AA10805AE457151F8531AA0614C81B95C3A48D12A46D9F5CEB057B97140`，仅本机生成，未安装或公开发布。
- 同一 ASAR 的 35 套窗口回归全部通过。首轮 FILE1D 11 项通过后，测试提交 `f81bea8` / `37981c3` / `a9ab95c` 补充 6 类损坏 sidecar、导入后模式切换 bytes / mtime 及完整源码 / 可编辑断言；运行时没有变化。冻结检出只快进这三项测试提交，加强后的 11 项专项再次通过。
- FILE1D 专项实际从开始页和菜单导入，核对真实最近文件完整 path；新目录与包四文件逐字节相等、图片实际解码、旧 basis 待定位、便签 / 标签、折叠 / 箭头、三模式及原 ZIP bytes / mtime 保持。三个取消点、dirty 保存 / 放弃 / 取消、main 直接 dirty 拒绝、重复导入不覆盖、预览 ZIP 外改拒绝、错误重试及 420px 均通过。CRC 正确的非法 / 未知 schema / 非法 UTF-8 YAML 与 JSON 全部在父目录对话框前拒绝。窄窗开始页、菜单和导入画布截图已视觉复核。
- 实际 Vite FILE1D / FILE1C / FILE1B / FILE1A / UX9 / UX8 / UX7 七套通过。原生对话框响应由隔离 main 模拟，文件系统、preload、IPC 和 renderer 实际运行；不能据此声称真实输入法或原生对话框人工验收。测试窗口已停止，5178 服务已停止。三项用户原有文件 SHA 保持且排除提交。

命令和日志摘要记录于本地 `out/qa/file1d-final-build-manifest.json`、`file1d-final-regression-manifest.json`、`file1d-final-guards-file1d.log`、`file1d-final-vite-a-manifest.json`。证据文件汇总包身份、全部命令和运行结果；本批没有失败运行被替换。私人测试目录、原日志 / 截图和本地安装包不随 Git 提交。

后续继续拆分普通副本打开行为、其他附件 / HTML / 间接资源、源路径改写与通用压缩支持，不将本批受限包导入扩大为完整工作区迁移承诺。

本批已推送 `origin/codex/file1d-open-bundle` 并创建、附加 [PR #26](https://github.com/KLucen/MerMarked/pull/26)，目标 main，待审未合并。运行时 `6f0beaa`，测试加强至 `a9ab95c`，验收 `ae3a226`；后续交付记录仅改文档。GitHub 云端 check runs / status contexts 为0，不把本地结果描述为云端CI。
