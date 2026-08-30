/**
 * dsh-docker — DeepSeek Harness Docker 容器管理
 *
 * 功能：
 * 1. 容器管理：列出、运行、停止、重启、删除、查看日志
 * 2. 镜像管理：构建、列出、删除、拉取
 * 3. 网络管理：列出、创建、删除
 * 4. 数据卷管理：列出、创建、删除
 * 5. Docker Compose：up/down/ps/logs
 * 6. 系统信息：docker info, docker version
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export const name = 'dsh-docker';
export const inject = ['settings', 'tools', 'commands'];

const configSchema = z.object({
  enabled: z.boolean().default(true),
  dockerPath: z.string().default('docker'),
  composePath: z.string().default('docker-compose'),
  defaultTimeout: z.number().int().min(1000).max(300000).default(30000),
});

type Config = z.infer<typeof configSchema>;

// ==================== Docker 执行器 ====================

function dockerExec(args: string, options?: { cwd?: string; timeout?: number }): string {
  const cmd = `${options?.cwd ? '' : ''}docker ${args}`;
  try {
    return execSync(cmd, {
      cwd: options?.cwd,
      timeout: options?.timeout || 30000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err: any) {
    const stderr = (err.stderr || '').trim();
    const stdout = (err.stdout || '').trim();
    throw new Error(stderr || stdout || `Docker 命令失败: ${cmd}`);
  }
}

function dockerExecJson<T = any>(args: string, options?: { cwd?: string; timeout?: number }): T {
  const output = dockerExec(args + ' --format \'{{json .}}\'', options);
  const lines = output.split('\n').filter(Boolean);
  return lines.map(line => JSON.parse(line)) as T;
}

// ==================== 容器管理 ====================

function listContainers(all: boolean = true): any[] {
  const args = `ps ${all ? '-a' : ''} --format \'{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}","status":"{{.Status}}","ports":"{{.Ports}}","created":"{{.CreatedAt}}","size":"{{.Size}}"}\'`;
  const output = dockerExec(args);
  if (!output) return [];
  return output.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function runContainer(image: string, options: {
  name?: string; detach?: boolean; ports?: string[]; volumes?: string[];
  env?: string[]; network?: string; command?: string;
} = {}): string {
  const args = ['run'];
  if (options.detach) args.push('-d');
  if (options.name) args.push(`--name ${options.name}`);
  if (options.ports) options.ports.forEach(p => args.push(`-p ${p}`));
  if (options.volumes) options.volumes.forEach(v => args.push(`-v ${v}`));
  if (options.env) options.env.forEach(e => args.push(`-e ${e}`));
  if (options.network) args.push(`--network ${options.network}`);
  args.push(image);
  if (options.command) args.push(options.command);
  return dockerExec(args.join(' '));
}

function stopContainer(id: string, timeout?: number): string {
  return dockerExec(`stop${timeout ? ` -t ${timeout}` : ''} ${id}`);
}

function removeContainer(id: string, force: boolean = false): string {
  return dockerExec(`rm${force ? ' -f' : ''} ${id}`);
}

function containerLogs(id: string, options: { tail?: number; since?: string; follow?: boolean } = {}): string {
  const args = ['logs'];
  if (options.tail) args.push(`--tail ${options.tail}`);
  if (options.since) args.push(`--since ${options.since}`);
  if (options.follow) args.push('-f');
  args.push(id);
  return dockerExec(args.join(' '), { timeout: options.follow ? 60000 : 10000 });
}

function inspectContainer(id: string): any {
  const output = dockerExec(`inspect ${id}`);
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function execInContainer(id: string, command: string): string {
  return dockerExec(`exec ${id} ${command}`);
}

function containerStats(id: string): any {
  const output = dockerExec(`stats ${id} --no-stream --format \'{"cpu":"{{.CPUPerc}}","mem_usage":"{{.MemUsage}}","mem_perc":"{{.MemPerc}}","net_io":"{{.NetIO}}","block_io":"{{.BlockIO}}","pids":"{{.PIDs}}"}\'`);
  try { return JSON.parse(output); } catch { return { raw: output }; }
}

// ==================== 镜像管理 ====================

function listImages(): any[] {
  const output = dockerExec('images --format \'{"id":"{{.ID}}","repo":"{{.Repository}}","tag":"{{.Tag}}","size":"{{.Size}}","created":"{{.CreatedSince}}","created_at":"{{.CreatedAt}}"}\'');
  if (!output) return [];
  return output.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function buildImage(context: string, options: { tag?: string; dockerfile?: string; buildArgs?: string[]; noCache?: boolean } = {}): string {
  const args = ['build'];
  if (options.tag) args.push(`-t ${options.tag}`);
  if (options.dockerfile) args.push(`-f ${options.dockerfile}`);
  if (options.buildArgs) options.buildArgs.forEach(a => args.push(`--build-arg ${a}`));
  if (options.noCache) args.push('--no-cache');
  args.push(context);
  return dockerExec(args.join(' '), { timeout: 300000 });
}

function pullImage(image: string): string {
  return dockerExec(`pull ${image}`, { timeout: 120000 });
}

function removeImage(id: string, force: boolean = false): string {
  return dockerExec(`rmi${force ? ' -f' : ''} ${id}`);
}

function tagImage(source: string, target: string): string {
  return dockerExec(`tag ${source} ${target}`);
}

// ==================== 网络管理 ====================

function listNetworks(): any[] {
  const output = dockerExec('network ls --format \'{"id":"{{.ID}}","name":"{{.Name}}","driver":"{{.Driver}}","scope":"{{.Scope}}","created":"{{.CreatedAt}}"}\'');
  if (!output) return [];
  return output.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function createNetwork(name: string, driver: string = 'bridge'): string {
  return dockerExec(`network create --driver ${driver} ${name}`);
}

function removeNetwork(id: string): string {
  return dockerExec(`network rm ${id}`);
}

// ==================== 数据卷管理 ====================

function listVolumes(): any[] {
  const output = dockerExec('volume ls --format \'{"name":"{{.Name}}","driver":"{{.Driver}}","mountpoint":"{{.Mountpoint}}"}\'');
  if (!output) return [];
  return output.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function createVolume(name: string, driver: string = 'local'): string {
  return dockerExec(`volume create --driver ${driver} ${name}`);
}

function removeVolume(id: string, force: boolean = false): string {
  return dockerExec(`volume rm${force ? ' -f' : ''} ${id}`);
}

// ==================== Compose ====================

function composeUp(cwd: string, options: { detach?: boolean; build?: boolean; services?: string[] } = {}): string {
  const args = ['-f', `${cwd}/docker-compose.yml`, 'up'];
  if (options.detach) args.push('-d');
  if (options.build) args.push('--build');
  if (options.services) args.push(...options.services);
  return dockerExec(`compose ${args.join(' ')}`, { cwd, timeout: 300000 });
}

function composeDown(cwd: string, options: { volumes?: boolean } = {}): string {
  const args = ['-f', `${cwd}/docker-compose.yml`, 'down'];
  if (options.volumes) args.push('-v');
  return dockerExec(`compose ${args.join(' ')}`, { cwd });
}

function composePs(cwd: string): any[] {
  const output = dockerExec('compose ps --format \'{"name":"{{.Name}}","command":"{{.Command}}","status":"{{.Status}}","ports":"{{.Ports}}","image":"{{.Image}}"}\'', { cwd });
  if (!output) return [];
  return output.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function composeLogs(cwd: string, options: { tail?: number; service?: string } = {}): string {
  const args = ['compose'];
  if (options.tail) args.push(`--tail ${options.tail || 100}`);
  args.push('logs');
  if (options.service) args.push(options.service);
  return dockerExec(args.join(' '), { cwd, timeout: 10000 });
}

// ==================== 系统信息 ====================

function dockerInfo(): any {
  const output = dockerExec('info --format \'{"server_version":"{{.ServerVersion}}","os":"{{.OperatingSystem}}","kernel":"{{.KernelVersion}}","cpus":{{.NCPU}},"memory":"{{.MemTotal}}","containers_running":{{.ContainersRunning}},"containers_stopped":{{.ContainersStopped}},"images":{{.Images}},"docker_root":"{{.DockerRootDir}}","storage_driver":"{{.Driver}}"}\'');
  try { return JSON.parse(output); } catch { return { raw: output }; }
}

function dockerVersion(): any {
  const output = dockerExec('version --format \'{"client":"{{.Client.Version}}","server":"{{.Server.Version}}","api":"{{.Client.API version}}","go":"{{.Client.Go version}}","git":"{{.Client.GitCommit}}","built":"{{.Client.BuildTime}}"}\'');
  try { return JSON.parse(output); } catch { return { raw: output }; }
}

function diskUsage(): string {
  return dockerExec('system df');
}

// ==================== 插件入口 ====================

export function apply(ctx: any, config: Config) {
  if (!config.enabled) return;

  // docker_ps — 列出容器
  ctx.effect(() => ctx.tools.register({
    name: 'docker_ps',
    description: '列出 Docker 容器。返回容器 ID、名称、镜像、状态、端口等信息。',
    parameters: {
      all: { type: 'boolean', description: '是否显示所有容器（默认只显示运行中）' },
      filter: { type: 'string', description: '过滤条件（如 status=running, name=web）' },
    },
    output: {
      schema: { type: 'json' },
      render(_args: unknown, value: unknown) {
        const containers = value as any[];
        if (containers.length === 0) return [{ type: 'text', text: '📭 没有容器' }];
        const lines = [`## 🐳 Docker 容器 (${containers.length})`];
        for (const c of containers) {
          const status = c.status?.includes('Up') ? '🟢' : '🔴';
          lines.push(`- ${status} **${c.name}** (${c.id?.substring(0, 12)})`);
          lines.push(`  镜像: ${c.image} | 状态: ${c.status}`);
          if (c.ports) lines.push(`  端口: ${c.ports}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args: { all?: boolean; filter?: string }) {
      return listContainers(args.all !== false);
    },
  }), 'dsh-docker: docker_ps');

  // docker_run — 运行容器
  ctx.effect(() => ctx.tools.register({
    name: 'docker_run',
    description: '运行 Docker 容器。支持指定名称、端口映射、环境变量、网络等。',
    parameters: {
      image: { type: 'string', description: '镜像名称（如 nginx:latest）' },
      name: { type: 'string', description: '容器名称' },
      detach: { type: 'boolean', description: '是否后台运行（默认 true）' },
      ports: { type: 'string', description: '端口映射，逗号分隔（如 8080:80,3000:3000）' },
      volumes: { type: 'string', description: '卷挂载，逗号分隔（如 /host/path:/container/path）' },
      env: { type: 'string', description: '环境变量，逗号分隔（如 KEY1=val1,KEY2=val2）' },
      network: { type: 'string', description: '网络名称' },
      command: { type: 'string', description: '启动命令' },
    },
    output: {
      schema: { type: 'json' },
      render(_args: unknown, value: unknown) {
        const id = value as string;
        return [{ type: 'text', text: `✅ 容器已启动\nID: ${id?.substring(0, 12)}` }];
      },
    },
    async execute(args: { image: string; name?: string; detach?: boolean; ports?: string; volumes?: string; env?: string; network?: string; command?: string }) {
      return runContainer(args.image, {
        name: args.name,
        detach: args.detach !== false,
        ports: args.ports?.split(',').map(s => s.trim()),
        volumes: args.volumes?.split(',').map(s => s.trim()),
        env: args.env?.split(',').map(s => s.trim()),
        network: args.network,
        command: args.command,
      });
    },
  }), 'dsh-docker: docker_run');

  // docker_stop — 停止容器
  ctx.effect(() => ctx.tools.register({
    name: 'docker_stop',
    description: '停止运行中的 Docker 容器。',
    parameters: { container: { type: 'string', description: '容器 ID 或名称' }, timeout: { type: 'number', description: '等待停止的超时秒数' } },
    output: { schema: { type: 'json' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: `✅ 容器已停止: ${(v as string)?.substring(0, 12)}` }] },
    async execute(args: { container: string; timeout?: number }) { return stopContainer(args.container, args.timeout); },
  }), 'dsh-docker: docker_stop');

  // docker_rm — 删除容器
  ctx.effect(() => ctx.tools.register({
    name: 'docker_rm',
    description: '删除 Docker 容器。',
    parameters: { container: { type: 'string', description: '容器 ID 或名称' }, force: { type: 'boolean', description: '强制删除' } },
    output: { schema: { type: 'json' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: `🗑️ 容器已删除: ${(v as string)?.substring(0, 12)}` }] },
    async execute(args: { container: string; force?: boolean }) { return removeContainer(args.container, args.force); },
  }), 'dsh-docker: docker_rm');

  // docker_logs — 查看日志
  ctx.effect(() => ctx.tools.register({
    name: 'docker_logs',
    description: '查看 Docker 容器日志。',
    parameters: {
      container: { type: 'string', description: '容器 ID 或名称' },
      tail: { type: 'number', description: '返回最后 N 行（默认 100）' },
      since: { type: 'string', description: '只显示指定时间后的日志（如 10m, 1h）' },
    },
    output: {
      schema: { type: 'json' },
      render(_args: unknown, value: unknown) {
        const log = value as string;
        const lines = log.split('\n').slice(-50);
        return [{ type: 'text', text: `## 📋 容器日志 (最近 ${lines.length} 行)\n\`\`\`\n${lines.join('\n')}\n\`\`\`` }];
      },
    },
    async execute(args: { container: string; tail?: number; since?: string }) {
      return containerLogs(args.container, { tail: args.tail || 100, since: args.since });
    },
  }), 'dsh-docker: docker_logs');

  // docker_exec — 在容器中执行命令
  ctx.effect(() => ctx.tools.register({
    name: 'docker_exec',
    description: '在运行中的容器内执行命令。',
    parameters: { container: { type: 'string', description: '容器 ID 或名称' }, command: { type: 'string', description: '要执行的命令' } },
    output: {
      schema: { type: 'json' },
      render(_args: unknown, value: unknown) {
        return [{ type: 'text', text: `\`\`\`\n${value}\n\`\`\`` }];
      },
    },
    async execute(args: { container: string; command: string }) { return execInContainer(args.container, args.command); },
  }), 'dsh-docker: docker_exec');

  // docker_stats — 容器资源统计
  ctx.effect(() => ctx.tools.register({
    name: 'docker_stats',
    description: '获取容器实时资源使用情况（CPU、内存、网络、IO）。',
    parameters: { container: { type: 'string', description: '容器 ID 或名称' } },
    output: {
      schema: { type: 'json' },
      render(_args: unknown, value: unknown) {
        const s = value as any;
        if (s.raw) return [{ type: 'text', text: s.raw }];
        return [{ type: 'text', text: `## 📊 容器统计\n- CPU: ${s.cpu}\n- 内存: ${s.mem_usage} (${s.mem_perc})\n- 网络: ${s.net_io}\n- 磁盘: ${s.block_io}\n- 进程: ${s.pids}` }];
      },
    },
    async execute(args: { container: string }) { return containerStats(args.container); },
  }), 'dsh-docker: docker_stats');

  // docker_images — 列出镜像
  ctx.effect(() => ctx.tools.register({
    name: 'docker_images',
    description: '列出本地 Docker 镜像。',
    output: {
      schema: { type: 'json' },
      render(_args: unknown, value: unknown) {
        const images = value as any[];
        if (images.length === 0) return [{ type: 'text', text: '📭 没有镜像' }];
        const lines = [`## 🖼️ Docker 镜像 (${images.length})`];
        for (const img of images) {
          lines.push(`- **${img.repo}:${img.tag}** (${img.id?.substring(0, 12)}) — ${img.size} (${img.created})`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute() { return listImages(); },
  }), 'dsh-docker: docker_images');

  // docker_build — 构建镜像
  ctx.effect(() => ctx.tools.register({
    name: 'docker_build',
    description: '从 Dockerfile 构建镜像。',
    parameters: {
      context: { type: 'string', description: '构建上下文路径' },
      tag: { type: 'string', description: '镜像标签（如 myapp:v1.0）' },
      dockerfile: { type: 'string', description: 'Dockerfile 路径（默认 ./Dockerfile）' },
      no_cache: { type: 'boolean', description: '不使用缓存' },
    },
    output: { schema: { type: 'json' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: `✅ 镜像构建完成\n\`\`\`\n${(v as string)?.split('\n').slice(-5).join('\n')}\n\`\`\`` }] },
    async execute(args: { context: string; tag?: string; dockerfile?: string; no_cache?: boolean }) {
      return buildImage(args.context, { tag: args.tag, dockerfile: args.dockerfile, noCache: args.no_cache });
    },
  }), 'dsh-docker: docker_build');

  // docker_compose — Compose 操作
  ctx.effect(() => ctx.tools.register({
    name: 'docker_compose',
    description: 'Docker Compose 操作：up/down/ps/logs。',
    parameters: {
      action: { type: 'string', description: '操作：up | down | ps | logs' },
      path: { type: 'string', description: 'docker-compose.yml 所在目录' },
      detach: { type: 'boolean', description: 'up 时是否后台运行' },
      build: { type: 'boolean', description: 'up 时是否重新构建' },
      tail: { type: 'number', description: 'logs 时返回的行数' },
    },
    output: {
      schema: { type: 'json' },
      render(_args: unknown, value: unknown) {
        const result = value;
        if (typeof result === 'string') return [{ type: 'text', text: result }];
        if (Array.isArray(result)) {
          const lines = [`## Compose 服务 (${result.length})`];
          for (const s of result) {
            lines.push(`- **${s.name}** — ${s.status}`);
            if (s.ports) lines.push(`  端口: ${s.ports}`);
          }
          return [{ type: 'text', text: lines.join('\n') }];
        }
        return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
      },
    },
    async execute(args: { action: string; path: string; detach?: boolean; build?: boolean; tail?: number }) {
      switch (args.action) {
        case 'up': return composeUp(args.path, { detach: args.detach !== false, build: args.build });
        case 'down': return composeDown(args.path);
        case 'ps': return composePs(args.path);
        case 'logs': return composeLogs(args.path, { tail: args.tail });
        default: throw new Error(`未知操作: ${args.action}`);
      }
    },
  }), 'dsh-docker: docker_compose');

  // docker_info — 系统信息
  ctx.effect(() => ctx.tools.register({
    name: 'docker_info',
    description: '获取 Docker 系统信息（版本、存储、容器数等）。',
    output: {
      schema: { type: 'json' },
      render(_args: unknown, value: unknown) {
        const info = value as any;
        if (info.raw) return [{ type: 'text', text: info.raw }];
        return [{ type: 'text', text: `## 🐳 Docker 信息\n- 版本: ${info.server_version}\n- OS: ${info.os}\n- 内核: ${info.kernel}\n- CPU: ${info.cpus} | 内存: ${info.memory}\n- 运行中: ${info.containers_running} | 已停止: ${info.containers_stopped}\n- 镜像数: ${info.images}\n- 存储驱动: ${info.storage_driver}\n- 数据目录: ${info.docker_root}` }];
      },
    },
    async execute() { return dockerInfo(); },
  }), 'dsh-docker: docker_info');

  // docker_networks — 网络管理
  ctx.effect(() => ctx.tools.register({
    name: 'docker_networks',
    description: '列出 Docker 网络。',
    output: {
      schema: { type: 'json' },
      render(_args: unknown, value: unknown) {
        const networks = value as any[];
        if (networks.length === 0) return [{ type: 'text', text: '📭 没有网络' }];
        const lines = [`## 🌐 Docker 网络 (${networks.length})`];
        for (const n of networks) lines.push(`- **${n.name}** (${n.driver}) — ${n.scope}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute() { return listNetworks(); },
  }), 'dsh-docker: docker_networks');

  // docker_volumes — 数据卷管理
  ctx.effect(() => ctx.tools.register({
    name: 'docker_volumes',
    description: '列出 Docker 数据卷。',
    output: {
      schema: { type: 'json' },
      render(_args: unknown, value: unknown) {
        const volumes = value as any[];
        if (volumes.length === 0) return [{ type: 'text', text: '📭 没有数据卷' }];
        const lines = [`## 💾 Docker 数据卷 (${volumes.length})`];
        for (const v of volumes) lines.push(`- **${v.name}** (${v.driver})`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute() { return listVolumes(); },
  }), 'dsh-docker: docker_volumes');

  // slash 命令 /docker
  ctx.effect(() => ctx.commands.register({
    name: 'docker',
    description: 'Docker 管理',
    input: { hint: 'ps | images | info | <container> logs | <container> exec <cmd>' },
    async handler(invocation: any) {
      const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return { kind: 'text', text: '用法: /docker ps | images | info | <container> logs' };
      const cmd = parts[0];
      switch (cmd) {
        case 'ps': { const c = listContainers(); return { kind: 'text', text: `${c.length} 个容器` }; }
        case 'images': { const i = listImages(); return { kind: 'text', text: `${i.length} 个镜像` }; }
        case 'info': { const info = dockerInfo(); return { kind: 'text', text: `Docker ${info.server_version} | ${info.containers_running} 运行中` }; }
        default: {
          if (parts[1] === 'logs') return { kind: 'text', text: containerLogs(cmd, { tail: 50 }) };
          if (parts[1] === 'exec') return { kind: 'text', text: execInContainer(cmd, parts.slice(2).join(' ')) };
          return { kind: 'text', text: `未知子命令: ${parts[1]}` };
        }
      }
    },
  }), 'dsh-docker: command');

  // 设置注册
  ctx.inject(['settings'], (sctx: any) => {
    const { settingsNamespace } = require('@deepseek-ai/dsh-settings');
    sctx.settings.register(settingsNamespace('docker'), configSchema, { base: config, expose: true, applies: 'live' });
  });
}
