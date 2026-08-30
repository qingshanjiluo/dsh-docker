# dsh-docker

> DeepSeek Harness Docker 容器管理插件

## 功能

- 🐳 **容器管理**: 列出、运行、停止、重启、删除、日志、执行命令
- 🖼️ **镜像管理**: 构建、拉取、列出、删除、标签
- 🌐 **网络管理**: 列出、创建、删除
- 💾 **数据卷**: 列出、创建、删除
- 📦 **Docker Compose**: up/down/ps/logs
- 📊 **系统信息**: Docker 版本、存储、资源统计

## 安装

```bash
npm install dsh-docker
```

## 工具

| 工具名 | 说明 |
|--------|------|
| `docker_ps` | 列出容器 |
| `docker_run` | 运行容器 |
| `docker_stop` | 停止容器 |
| `docker_rm` | 删除容器 |
| `docker_logs` | 查看日志 |
| `docker_exec` | 执行命令 |
| `docker_stats` | 资源统计 |
| `docker_images` | 列出镜像 |
| `docker_build` | 构建镜像 |
| `docker_compose` | Compose 操作 |
| `docker_info` | 系统信息 |
| `docker_networks` | 列出网络 |
| `docker_volumes` | 列出数据卷 |

## 命令

- `/docker ps` — 列出容器
- `/docker images` — 列出镜像
- `/docker info` — 系统信息
- `/docker <container> logs` — 查看容器日志
- `/docker <container> exec <cmd>` — 在容器中执行命令

## License

MIT
