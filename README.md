# dsh-docker

> DeepSeek Harness Docker 容器管理

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ✨ 功能特性

- 🐳 **容器管理**: 列出、运行、停止、重启、删除、查看日志、执行命令
- 🖼️ **镜像管理**: 构建、拉取、列出、删除、标签
- 🌐 **网络管理**: 列出、创建、删除
- 💾 **数据卷**: 列出、创建、删除
- 📦 **Docker Compose**: up/down/ps/logs
- 📊 **系统信息**: Docker 版本、存储、资源统计

## 📦 安装

```bash
npm install dsh-docker
```

## 🛠️ 工具

| 工具名 | 描述 | 参数 |
|--------|------|------|
| `docker_ps` | 列出容器 | `all`, `filter` |
| `docker_run` | 运行容器 | `image`, `name`, `ports`, `volumes` |
| `docker_stop` | 停止容器 | `container`, `timeout` |
| `docker_rm` | 删除容器 | `container`, `force` |
| `docker_logs` | 查看日志 | `container`, `tail`, `since` |
| `docker_exec` | 执行命令 | `container`, `command` |
| `docker_stats` | 资源统计 | `container` |
| `docker_images` | 列出镜像 | 无 |
| `docker_build` | 构建镜像 | `context`, `tag`, `dockerfile` |
| `docker_compose` | Compose 操作 | `action`, `path` |
| `docker_info` | 系统信息 | 无 |
| `docker_networks` | 列出网络 | 无 |
| `docker_volumes` | 列出数据卷 | 无 |

## 📋 命令

- `/docker ps` — 列出容器
- `/docker images` — 列出镜像
- `/docker info` — 系统信息
- `/docker <container> logs` — 查看日志
- `/docker <container> exec <cmd>` — 执行命令

## ⚙️ 配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `true` | 启用插件 |
| `dockerPath` | string | `docker` | Docker 路径 |
| `composePath` | string | `docker-compose` | Compose 路径 |
| `defaultTimeout` | number | `30000` | 默认超时(ms) |

## 📄 License

MIT
