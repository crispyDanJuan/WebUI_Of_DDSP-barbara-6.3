# NOTICE / 来源说明

本仓库是 **DDSP-barbara-6.3** 整合包的 WebUI 增强层，不是原项目本身。

## 上游项目

- **DDSP-SVC**  
  Author: yxlllc  
  https://github.com/yxlllc/DDSP-SVC  
  License: MIT

- **DDSP-barbara-6.3**  
  DDSP-SVC 的整合/调参版本，随整合包提供。  
  本仓库不包含其 `env/`、`pretrain/`、`exp/`、`data/` 等大文件。

## 本仓库的修改

- 新增 `webui/`：本地 HTTP 服务、任务系统、推理引擎封装和前端页面；
- 新增 WebUI 启动/停止/打开脚本；
- 扩展 `logger/saver.py`：检查点同名不覆盖，自动追加 `_2`、`_3`；
- 扩展 `logger/utils.py`：读取带版本后缀的检查点；
- 扩展 `reflow/solver.py`：总步数停止、最终保存、永久保存间隔支持 0；
- 扩展 `train_reflow.py`：支持从零训练或从指定模型继续；
- 新增/调整 `configs/` 的 WebUI 默认值。

## 未包含的第三方内容

- `navigator_audio_toolkit_v0.1.2.exe`（可选外部工具，请从原整合包获取）；
- 预训练模型、特征编码器、用户数据和训练结果；
- 原整合包自带的 Python 环境。

## 使用声明

请遵守原项目和整合包的使用条款，仅使用拥有合法授权的数据集和声音进行训练/转换。使用者对自己生成的内容和用途负责。
