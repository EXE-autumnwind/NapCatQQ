# 说明

此为NapCat的第三方维护分支，仅供学习交流使用

# NapCat

_Modern protocol-side framework implemented based on NTQQ._

> 云起兮风生，心向远方兮路未曾至.

</div>

---

## Welcome

- NapCatQQ is a modern implementation of the Bot protocol based on NTQQ.
  - NapCatQQ 是现代化的基于 NTQQ 的 Bot 协议端实现

## Feature

- **Easy to Use**
  - 作为初学者能够轻松使用.
- **Quick and Efficient**
  - 在低内存操作系统长时运行.
- **Rich API Interface**
  - 完整实现了大部分标准接口.
- **Stable and Reliable**
  - 持续稳定的开发与维护.

## Quick Start

可前往 [Release](https://github.com/EXE-autumnwind/NapCatQQ/releases/) 页面下载最新版本

Docker 地址 `ghcr.io/exe-autumnwind/napcat`（标签 `latest` / 具体版本号，公开可拉取）

```bash
docker pull ghcr.io/exe-autumnwind/napcat:latest
docker run -d --name napcat -p 6099:6099 \
  -v "$PWD/napcat/config:/app/napcat/config" \
  -v "$PWD/napcat/data:/app/napcat/data" \
  ghcr.io/exe-autumnwind/napcat:latest
docker logs -f napcat   # 首次启动会在日志里打印 WebUI 登录 token
```

**首次使用**请务必查看如下文档看使用教程

> 项目非盈利，涉及 对接问题/基础问题/下层框架问题 请自行搜索解决，本项目社区不提供此类解答。

## 从旧版本升级 / 迁移

上游 `NapNeko/NapCatQQ` 已归档，旧版本内置的「检查更新」仍指向上游，会导致拿不到新版本。
用迁移脚本把安装目录替换成本仓库的最新 Release 即可（等价于手动升级一次），执行之后
WebUI 的检查更新、版本列表、临时版本（Action artifacts）都会指向本仓库。

脚本随每个 Release 一起发布，也可以在仓库的 `scripts/` 目录里取：

- `migrate-update-source.sh` —— Linux / macOS
- `migrate-update-source.bat` —— Windows

### Linux / macOS

```bash
chmod +x migrate-update-source.sh

# 查看将更改的文件
./migrate-update-source.sh --dir /opt/napcat --dry-run

# 更新
./migrate-update-source.sh --dir /opt/napcat

# 指定版本 / 下载加速前缀
./migrate-update-source.sh --dir /opt/napcat --tag v4.18.44 --mirror https://ghproxy.com/
```

### Windows

```bat
:: 查看将更改的文件
migrate-update-source.bat --dir "C:\napcat" --dry-run

:: 更新
migrate-update-source.bat --dir "C:\napcat"

:: 指定版本 / 下载加速前缀
migrate-update-source.bat --dir "C:\napcat" --tag v4.18.44 --mirror https://ghproxy.com/
```

> Docker： `docker pull ghcr.io/exe-autumnwind/napcat:latest` 后重建容器即可；容器内的更新会在重建时丢失，WebUI 也会拒绝在容器内执行更新。

## Thanks

- [Lagrange](https://github.com/LagrangeDev/Lagrange.Core) 对本项目的大力支持 参考部分代码 已获授权

- [AstrBot](https://github.com/AstrBotDevs/AstrBot) 是完美适配本项目的LLM Bot框架 在此推荐一下

- [MaiBot](https://github.com/MaiM-with-u/MaiBot) 一只赛博群友 麦麦 Bot框架 在此推荐一下

- [qq-chat-exporter](https://github.com/shuakami/qq-chat-exporter/) 基于NapCat的消息导出工具 在此推荐一下

- 不过最最重要的 还是需要感谢屏幕前的你哦~

---
## License

本项目采用 混合协议 开源，因此使用本项目时，你需要注意以下几点：

1. 第三方库代码或修改部分遵循其原始开源许可.
2. 本项目获取部分项目授权而不受部分约束
2. 项目其余逻辑代码采用[本仓库开源许可](./LICENSE).

**本仓库仅用于提高易用性，实现消息推送类功能，此外，禁止任何项目未经仓库主作者授权基于 NapCat 代码开发。使用请遵守当地法律法规，由此造成的问题由使用者和提供违规使用教程者负责。**
