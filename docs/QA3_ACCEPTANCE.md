# QA3 · QA1 边缘拖动修复与原生诊断

2026-11-20，基于 FILE1D 已合并的 main `4214054`，分支 `codex/qa3-software-closeout`。本批开发与验证中。QA1 的原始失败仍保留；本记录只核准本批实际取得的证据，不预先宣称 QA1 / P0 整体退出。

## 本批修复与退出条件

本批稳定复现一个独立的边缘拖动偏差：旧 FILE1D 包在0.11 / 1 / 2缩放下，三个边缘auto-pan场景分别偏离抓取点约10.875 / 10.5 / 10.875 CSS px，并写入画布；六个中央已选 / 未选场景均精确通过。其他199卡、箭头、Markdown / YAML bytes与mtime保持。原 QA1 单次约742px大跳没有逐事件证据，本批不将两者视为同一根因。

本地 `@xyflow/system@0.0.83` drag handler在首次auto-pan启动后才执行预先计算的pointer更新；pan的坐标校正被旧pointer覆盖。在原位置捕获启动条件，完成pointer更新后再启动，保留原先首次越阈后下一move才开始的时机，速度、停留、release和cancel逻辑不改。采用精确版本与原始 / 修复后整文件SHA的安装补丁，自动校验两个Vite使用的ESM入口；未知版本或字节拒绝，重复安装幂等。无新依赖 / schema，决定 ADR-061。

退出条件：

1. 聚焦测试提取真实依赖handler与async pan逻辑，在三个缩放下证明旧版偏差、新顺序消除；同时证明首次阈值时机保持，校验补丁完整字节、幂等、半完成安装及未知版本 / 字节拒绝。
2. 同包九场景记录真实pointer、逐帧transform / viewport、实际位移及落盘坐标；中央和auto-pan均在1.25 CSS px残差内，三文件边界与其他卡 / 箭头保持。首次阈值移动同样不能掩盖大跳，外来输入须单独报告。
3. 干净检出 `npm ci` 实际应用补丁，类型检查、全量单测及Windows make；同一固定ASAR的既有窗口与新增拖动 / Squirrel专项通过，实际Vite相关回归通过。原始失败不覆盖，三项用户原修改保持，候选进程与开发服务停止。

## 真实辅助客户端：诊断推进，性能仍未解决

使用 computer-use 的原生Windows查询，在5MiB生成文档上实际触发 `inlineTextBoxes`；QA2仅添加 `webContents / extendedProperties` 的实验没有覆盖这项。旧包打开 / 返回阅读分别记录约592 / 575ms长帧；trace覆盖toplevel，返回阶段renderer `SerializeLifecycleStage` 559.842ms，Browser AX 618.088ms，外层任务分别577.121 / 656.397ms，嵌套事件不相加。样本失焦，只作诊断，不判正式预算。

完整HAST根块分批挂载 / AX暴露原型已试验并撤回。开发模式首开7947ms、缓存返回1299ms，返回仍有433.706ms renderer序列化和705.422ms Browser AX任务，没有达到目标。原型与旧包构建方式及焦点不同，不能计算公平的回归或改善比例；它不随本批发布。源快照与patch / trace保留在本地out/qa。没有关闭辅助功能或排除正文来换取结果。

## Squirrel：打包对照排除未证实修复

纯依赖mock曾观察外层在helper close前调用quit，但实际旧FILE1D包的install / updated / uninstall三个hook均在假helper阻塞700ms内存活，零BrowserWindow，release后约100ms退出0。读取ASAR确认确为原旧gate；因此不存在可据此交付的“实际提前退出修复”，相关产品helper和改动已撤回。保留仅作用于生成临时目录、不会安装或改用户快捷方式的C#假Update及真实打包测试。

历史卸载二进制残留仍需真实生命周期过程证据。精确框架源码在删除后有意重建 `.dead`，并吞掉目录删除异常，退出0不能证明零残留；本批不删除真实安装目录，也不把当前目录已不存在解释为已修复。见 [FullUninstall](https://github.com/Squirrel/Squirrel.Windows/blob/eef37460ae/src/Squirrel/UpdateManager.ApplyReleases.cs#L96) 和 [DeleteDirectoryOrJustGiveUp](https://github.com/Squirrel/Squirrel.Windows/blob/eef37460ae/src/Squirrel/Utility.cs#L468)。

## 数据与环境边界

不改 Markdown、YAML、JSON schema 或依赖版本。修复只影响普通拖动的坐标，仍只提交画布JSON，不修改源文和批注。测试只用生成fixture、绝对隔离profile和选定exe。GUI / 生命周期串行，trace与正式性能分开。保留原QA1 / QA2冻结包及三项用户原修改。

真实IME已在QA1取得本机证据；本批不扩大为新包重验。物理跨屏、跨卷、干净Windows与公开发布许可 / 签名 / 渠道继续独立等待验收。内存没有确定泄漏根因，不以有限采样宣称解决。
