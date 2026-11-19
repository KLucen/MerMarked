# FILE1A 同目录已保存副本验收

2026-11-15。基线 main `5ccea0d`（已合并 PR #22），分支 `codex/file1a-saved-copy`。本批为 FILE1 的受限子批次；跨目录另存为与资源打包不在本批。本批本机软件退出条件通过，FILE1、QA1 与 P0 尚未整体退出。

## 行为与数据合同

文档菜单提供「在当前文件夹创建已保存副本…」。由主进程选择新名称，复制已保存 Markdown 与实际存在的 `.annotations.yaml` / `.mermarkd.json` 原字节；BOM、换行、标签、待定位锚点、旧 basis、卡片坐标、折叠及箭头端点保持。不存在的 sidecar 不凭空生成；无法读取或格式不支持则整批拒绝。原文仍打开，不改变模式，不增加最近文件。

同目录保持相对附件解析位置，附件共用，不复制资源、不改链接。显式自链接仍按原文字解释。跨目录拒绝，未保存正文、表单、组合及待提交输入先由用户处理，不隐式保存或丢弃。新 IPC 无参数，路径来自 main 原生对话框；main 独立核验当前会话、dirty 与原文事务。

## 发布与中断恢复

在同目录私有 staging 写入并同步候选，userData 保存不可变日志。目标通过独占硬链接按 sidecar、Markdown 顺序创建；链接源是独立 staging 副本，编辑副本不会改变原文件。三种目标任一存在即拒绝。源三文件在发布前重读比较；外部变化拒绝，不覆盖文件。

已发布目标绝不由失败清理删除。无目标发布时只清理可核验的私有 staging / 日志。有部分 sidecar 而 Markdown 缺失时，用户明确恢复可从原 staging 快照补齐；不能从后来变化的原文重建旧副本。Markdown 已存在但应有 companion 缺失时报告冲突，保留外部删除。外部修改、同内容 inode 替换、目标竞态、缺失候选或非法日志都保留数据和日志。活跃作业返回 busy；其他 PID 只 signal 0 查询，PID 重用可能保守阻止恢复。

恢复同名目标返回 `restored`，明确是先前快照；复制当前版本需新名称。选择「仅创建新副本」不恢复或清理旧副本。日志建立前退出可能留未发布 staging；三文件并非文件系统原子提交，不承诺 directory fsync 或物理断电持久性。MD 缺失不能区分从未发布与发布后外部删除，主动恢复可能补齐它。硬链接不受支持时安全拒绝。

## 退出条件与证据

- [x] 类型检查及 22 项 store 测试通过，含真实子进程在 sidecar / Markdown 发布后退出 73、重启恢复、外部修改与 inode 替换、活跃 owner、缺失候选、无目标清理、独立副本及原文件 bytes/mtime。
- [x] 干净检出 npm ci、类型检查、完整单测与 Squirrel make。
- [x] 最终包 FILE1A 专项及既有 31 套窗口回归。
- [x] 实际 Vite FILE1A / UX9 / UX8 / UX7 与窄窗截图复核。
- [x] 构建身份、原失败、用户三文件完整性与 GitHub PR 记录。

窗口测试使用生成的临时文档与绝对隔离 profile，原生对话框响应由测试 main 模拟；Chromium 组合测试不替代物理输入法。本批不重做安装、原生辅助客户端或正式性能采样。QA1 已有单次拖动异常、增强 AX 路径、卸载残留及设备 / 发布门槛继续独立跟踪。
## 最终验证记录

- 运行时代码提交 `76fcd03e9641352cb20221b7fa807ff45723b944`；后续 `996307e` / `64c362f` 只修改窗口测试，产品 src、package、lock 与构建配置无差异。干净检出使用 Node 24.20.0、npm 11.19.0、Electron 44.4.1，完成 `npm ci`、`npm run typecheck`、`npm test`（349/349）及 `npm run make`。依赖锁和冻结的 QA1 产物保持。
- 最终 ASAR SHA-256 `5A3BDF5D455EF919F3405623E80E164C4386D91F49EE995567BE565DD36FC61E`；Setup SHA-256 `596498321255FECA7E52585DFD3698D9F4F3AECB8D13DBB57F6B6DED50B75C8D`。安装包仅本地生成，本批没有执行安装或公开发布。
- 同包 FILE1A 九项专项及既有 31 套窗口全部通过。最终 `file1a-final-e-regression-manifest.json` 复用并核验 C 轮前 19 套的日志摘要，再从 UX2 继续。专项验证原文三文件 bytes/mtime、旧 basis/待定位、标签/便签、折叠/箭头、共享图片实际解码、缺失 companion、取消、三类目标存在、跨目录/非法 sidecar、dirty、Chromium composition、420 px 菜单与旧快照显式恢复。
- 实际 Vite FILE1A / UX9 / UX8 / UX7 四套通过，最终服务端口 5178 已关闭。420 px 菜单与副本画布截图已视觉复核。对话框响应在隔离 main 模拟，不能据此宣称物理系统对话框或真实 IME 新增验收。
- 初始 FILE1A A 轮 8/9，dirty 用例因源码回焦尚未结束而菜单关闭；等待 selection/focus 更新后 B/C 与 Vite 九项全过。UX2 C 轮撤销后仍 dirty，D 轮末尾菜单按钮不可见，失败日志保留。源码先 onChange 发布 dirty、下一 rAF 才 select/focus，而 popover 移出焦点即关闭；测试补齐帧及焦点同步，并增强进入/退出专注模式与撤销完整文本一致断言。旧包未改 UX2 的单次对照通过，不以该结果声称旧包也已复现失败；没有改产品撤销逻辑。
- 三项用户原文件 SHA-256 全部保持且排除提交。证据汇总见 [FILE1A_EVIDENCE.json](FILE1A_EVIDENCE.json)，原日志、截图、生成文档与安装包留在本地，不自动上传用户 Markdown 或 sidecar。

复现：`npm run typecheck`、`npm test`、`npm run make`、`npm run test:e2e:file1a`。隔离包通过 `MERMARKD_QA_EXE` 选择；专项输出以 `MERMARKD_QA_ARTIFACT_PREFIX` 避免覆盖。完整 32 套命令和 Vite 启停记录已附于证据。store 上限为 Markdown 32 MiB、YAML 1 MiB、JSON 4 MiB；只复制文件内容，不承诺保留 ACL、ADS、原文件时间戳或硬链接关系。

下一步可继续 FILE1 的跨目录资源与副本切换方案，先固定附件授权、相对引用改写和失败恢复的预览合同，再实现；不将当前同目录入口扩大为完整可移植工作区。

交付：分支 `codex/file1a-saved-copy` 已推送，创建并附加 [PR #23](https://github.com/KLucen/MerMarked/pull/23)，目标 main，待审未合并。运行时代码、测试同步和验收记录分别可追溯；最终回执另核对远端 HEAD。
