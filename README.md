# DDSP Studio WebUI

DDSP-barbara-6.3 的本地 WebUI 增强包。数据预处理、训练、推理、模型管理、结果试听、TensorBoard、实时变声和音频工具箱都可以在浏览器中完成。

> 这是 **DDSP-barbara-6.3 的叠加增强包，不是完整整合包**。  
> 使用前需要已有原版 DDSP-barbara-6.3（包含 `env/`、`pretrain/`、`reflow/` 等目录）。

## 功能

- 推理转换：上传或选择干声、模型选择、变调、音区偏移、共振峰、推理步数、采样方法、音高提取器。
- 数据预处理：训练/验证集上传、试听、多选删除、全部删除、随机划分验证集、特征提取。
- 模型训练：训练名称、从零开始或从指定检查点继续、总步数、永久保存间隔、实时状态、日志和 loss 曲线。
- 模型管理：模型命名、默认模型、配置编辑、上传、下载、重命名、删除（二次确认）。
- 结果库：试听、下载、打开目录、删除。
- 工具中心：TensorBoard、实时变声、音频工具箱、内置文件夹浏览。
- 试听音频跨页面继续播放，底部提供全局播放条。
- 模型命名和训练名称保存在 `webui/model_labels.json`，不修改权重文件。

## 环境要求

- Windows 10 / 11
- 原版 **DDSP-barbara-6.3** 整合包
- 原整合包自带的 `env/` Python 环境
- 推理建议 NVIDIA GPU；CPU 也可以运行，但速度较慢
- 浏览器：Chrome / Edge（推荐普通权限启动）

## 安装

### 方法一：直接覆盖

1. 解压本仓库；
2. 将仓库根目录的所有文件和文件夹复制到 DDSP-barbara-6.3 根目录；
3. 遇到同名文件时选择替换；
4. 双击 `启动WebUI.bat`。

### 方法二：使用部署工具

1. 把整个仓库文件夹放进 DDSP-barbara-6.3 根目录；
2. 双击 `部署WebUI工具.bat`；
3. 部署工具会先备份被覆盖的文件，再复制 WebUI；
4. 回到整合包根目录，双击 `启动WebUI.bat`。

## 启动与停止

```text
启动WebUI.bat   启动服务并自动打开浏览器
打开webui.bat   服务已启动时，只重新打开页面
停止WebUI.bat   停止 WebUI 服务
```

默认地址：

```text
http://127.0.0.1:7890/
```

如果 7890 被占用，会自动使用下一个端口，实际端口记录在 `webui/runtime.json`。

## 目录说明

```text
configs/                训练配置（max_steps=0，num_workers=0）
logger/saver.py         检查点保存：同名文件不覆盖，自动加 _2、_3
logger/utils.py         检查点读取：支持 model_2000_2.pt
reflow/solver.py        训练循环：总步数、验证、永久保存
preprocess.py           数据预处理
train_reflow.py         训练入口：从零开始或指定模型继续
webui/                  WebUI 服务与前端
webui/static/           前端页面（无构建步骤）
启动WebUI.bat
打开webui.bat
停止WebUI.bat
WebUI使用说明.md         完整中文使用说明
部署WebUI工具.bat        叠加部署工具
```

## 不包含的内容

为了保持仓库体积可控，以下内容不放入 Git 仓库：

- `env/`：原整合包的 Python 环境
- `pretrain/`、`exp/`：预训练权重和用户训练模型
- `data/`、`raw/`、`results/`：用户数据集、输入音频和转换结果
- `cache/`：音高缓存
- `navigator_audio_toolkit*.exe`：可选外部音频工具箱
- 日志、运行时配置、浏览器配置
- `DDSP原文件/` 等参考副本

请从原 DDSP-barbara-6.3 整合包获取这些内容。

## 常见问题

### 浏览器提示“现有实例正在以提升的权限运行”

这是 Edge 自身已有管理员权限实例导致的。请退出 Edge 后重试，或优先使用 Chrome。不要用“以管理员身份运行”启动 WebUI。

### 训练报 `PermissionError: [WinError 5]`

Windows 受限环境不允许 DataLoader 创建多进程管道。训练配置已经默认：

```yaml
train:
  num_workers: 0
```

请在训练页面保持 `DataLoader 进程 = 0`。

### 训练或工具进程没有随窗口关闭

WebUI 会处理控制台关闭事件，并终止训练、预处理和工具子进程。若仍残留，请使用 `停止WebUI.bat`，或在任务管理器中结束对应的 `python.exe` / `navigator_audio_toolkit*.exe`。

### 快速访问无法打开系统资源管理器

受限环境下 Windows 会拒绝 WebUI 进程启动资源管理器。快速访问已提供 WebUI 内置文件浏览器。

## 许可证与来源

本项目基于 **DDSP-SVC**（作者 yxlllc）及其 DDSP-barbara 整合包进行 WebUI 增强，原项目采用 MIT License。详见 [LICENSE](LICENSE) 和 [NOTICE.md](NOTICE.md)。

WebUI 代码为本地离线工具，不会把音频、模型或训练数据上传到互联网。

## 开发说明

前端是原生 ES Module + CSS，没有 Node 构建步骤；后端是 Python 标准库 `ThreadingHTTPServer`。修改后直接刷新页面即可，服务重启由 `启动WebUI.bat` 完成。
