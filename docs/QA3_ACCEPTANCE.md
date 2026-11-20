# QA3 · QA1 边缘拖动修复与原生诊断

2026-11-20，基于 FILE1D 已合并的 main `4214054`，分支 `codex/qa3-software-closeout`。本批边缘偏差修复的本机退出条件通过，证据见 [QA3_EVIDENCE.json](QA3_EVIDENCE.json)。QA1的原始失败仍保留，QA1 / P0未整体退出。

## 本批修复与退出条件

本批稳定复现一个独立的边缘拖动偏差：旧 FILE1D 包在0.11 / 1 / 2缩放下，三个边缘auto-pan场景分别偏离抓取点约10.875 / 10.5 / 10.875 CSS px，并写入画布；六个中央已选 / 未选场景均精确通过。其他199卡、箭头、Markdown / YAML bytes与mtime保持。原 QA1 单次约742px大跳没有逐事件证据，本批不将两者视为同一根因。

本地 `@xyflow/system@0.0.83` drag handler在首次auto-pan启动后才执行预先计算的pointer更新；pan的坐标校正被旧pointer覆盖。在原位置捕获启动条件，完成pointer更新后再启动，保留原先首次越阈后下一move才开始的事件时机、autoPanSpeed配置和计算公式，首次距离按本次更新的mousePosition计算，release和cancel原字节不改。采用精确版本与原始 / 修复后整文件SHA的安装补丁，自动校验两个Vite使用的ESM入口；未知版本或字节拒绝，重复安装幂等。无新依赖 / schema，决定 ADR-061。

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

## 冻结产物与实际验证

- 运行时 `55af10b4052b8a1c6c5756e82d2a74257942ebb2` 的独立detached检出 `C:\Users\KLucen\.codex\worktrees\mermarkd-qa3-final` 完成 `npm ci`、类型检查、470/470单测和Windows make。ci自动应用并核验两个ESM均为A24AD58C…C1E699，10项新增纯测试覆盖真实handler时序与安装边界。源clean、lock、主工作区index和既有QA1冻结产物保持。
- ASAR4,120,599bytes，SHA-256 `BBC424DBE9FFDD1616D71CBC69C639FE0E91457103E378F36096D47050AB6047`；Setup154,852,864bytes，SHA-256 `1E389F8612D66EF61B39D59384752B64F1115584E5C062131AD2C2C9B36541FA`。本地包未安装或公开发布。
- ASAR实际renderer与冻结生成文件逐字节一致，1,120,902bytes / SHA `D2E267915D08CA37B6F9D35937B9095B3E2E0CB036E4157C7860BEBA1438ED5F`。压缩后的实际handler已确认捕获条件→更新pointer→启动pan；变量名压缩不影响该数据流。
- 同一ASAR的37套窗口回归全部通过，包含新拖动九项与假helper打包hook三项。三个边缘最终残差0，中央最大约0.00002 CSS px，初始jump和1.25 CSS px阈值保持；原文 / 批注、其他199卡和箭头均核验。截图已视觉检查。
- Vite A首个场景未打开fixture、截图仍在开始页，后续八场景通过；该轮失败manifest / 截图保留，服务已停。发现测试导航后可命中旧开始页的竞态，`2cceee7` 仅补实际URL和页面完成等待，不改产品、位移断言或ASAR。加强后的九项打包专项再次通过。实际Vite B的QA3拖动 / FILE1D / FILE1C / FILE1B / FILE1A / UX9 / UX8 / UX7八套全部通过，服务和候选窗口已停止，三项用户原文件SHA保持。

本地命令与日志位于 `out/qa/qa3-final-build-manifest.json`、`qa3-final-regression-manifest.json`、`qa3-final-guards-qa3-drag.log`、`qa3-final-vite-a-manifest.json` 及独立B轮前缀。原始AX诊断、A / B / C拖动失败与Squirrel旧包通过回执均保留；生成fixture / profile、原始trace / 图片和本地安装包不随Git公开上传。
