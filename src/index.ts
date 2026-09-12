/**
 * Docker inspection tools for DeepSeek Harness.
 *
 * `docker_ps` lists containers, `docker_logs` tails one container's logs, and
 * `docker_compose_config` validates a Compose file. Each tool builds its own
 * `docker` argv and runs it through {@link Config.runCommand}, an injectable
 * seam that defaults to `spawnSync` from `node:child_process`. Because the seam
 * is configuration, unit tests — and hosts without a reachable daemon — inject a
 * fake runner: no network, no real subprocess, no live engine is required.
 * @module @qingshanjiluo/dsh-docker
 */

import { spawnSync } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-docker'
export const inject = ['tools']

// ---------------------------------------------------------------------------
// Command seam
// ---------------------------------------------------------------------------

/** One finished command: exit status plus the captured output streams. */
export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * How this plugin executes one docker invocation. `argv[0]` is the executable
 * and the rest are literal arguments — never a shell string — so argument
 * quoting is not an attack surface. Implementations may be sync or async.
 */
export type RunCommand = (argv: readonly string[], timeoutMs: number) => CommandResult | Promise<CommandResult>

/** The production seam: `spawnSync` with no shell, a hard timeout, and a cap. */
export function defaultRunCommand(argv: readonly string[], timeoutMs: number): CommandResult {
  const [file, ...args] = argv
  if (!file) return { exitCode: -1, stdout: '', stderr: 'nothing to run: the command was empty' }
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) return { exitCode: -1, stdout: '', stderr: `${file}: ${result.error.message}` }
  if (result.status === null || result.status === undefined) {
    return {
      exitCode: 124,
      stdout: result.stdout ?? '',
      stderr: `${file} was killed (${result.signal ?? 'unknown signal'}) after ${timeoutMs}ms`,
    }
  }
  return { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Deployment policy for the Docker tools. */
export interface Config {
  /** Executable the tools invoke: `docker`, `podman`, or an absolute path. */
  dockerPath: string
  /** Per-command timeout in milliseconds handed to {@link RunCommand}. */
  timeoutMs: number
  /** Hard cap on the log lines `docker_logs` may return, however large `tail` is. */
  maxLogLines: number
  /**
   * Injection point for the process runner. Defaults to
   * {@link defaultRunCommand}; override it in tests or on daemon-less hosts.
   */
  runCommand: RunCommand
}

/** Schemastery configuration for the Docker tools. */
export const Config: z<Config> = z.object({
  dockerPath: z.string().default('docker'),
  timeoutMs: z.number().default(15000),
  maxLogLines: z.number().default(400),
  runCommand: z.function().default(defaultRunCommand),
})

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Render an argv as a copy-pasteable command line for the model. */
function formatArgv(argv: readonly string[]): string {
  return argv.map((token) => (/^[\w@%+=:,./-]+$/.test(token) ? token : `'${token.replace(/'/g, `'\\''`)}'`)).join(' ')
}

/** First non-blank line of a stream, trimmed and clipped — used for messages. */
function firstLine(text: string, limit = 400): string {
  const line = text.split(/\r?\n/).find((row) => row.trim() !== '')?.trim() ?? ''
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

/** A single model-supplied token is safe to hand to docker verbatim. */
function tokenProblem(value: string, label: string): string | undefined {
  if (value.trim() === '') return `${label}: must not be empty`
  if (/[\r\n\0]/.test(value)) return `${label}: must not contain newlines or NUL characters`
  if (value.startsWith('-')) return `${label}: must not start with "-" (docker would read it as an option)`
  if (/\s/.test(value)) return `${label}: must not contain whitespace`
  return undefined
}

/** A path may contain spaces but must stay on one line. */
function pathProblem(value: string, label: string): string | undefined {
  if (value.trim() === '') return `${label}: must not be empty`
  if (/[\r\n\0]/.test(value)) return `${label}: must not contain newlines or NUL characters`
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(scalarText).filter((text) => text !== '').join(',')
  return ''
}

/** Read one docker JSON field, tolerating the key-case differences per version. */
function field(row: Record<string, unknown>, key: string): string {
  const direct = row[key]
  if (direct !== undefined) return scalarText(direct)
  const lower = key.toLowerCase()
  for (const [name, value] of Object.entries(row)) {
    if (name.toLowerCase() === lower) return scalarText(value)
  }
  return ''
}

/**
 * Parse `docker ps --format json`, which is one JSON object per line on current
 * engines and a single JSON array on older ones.
 * @param stdout - raw standard output of the command.
 * @returns the decoded rows plus whether any of the text parsed.
 */
function parseJsonRows(stdout: string): { rows: Record<string, unknown>[]; parsed: boolean } {
  const text = stdout.trim()
  if (text === '') return { rows: [], parsed: true }
  let whole: unknown
  try {
    whole = JSON.parse(text)
  } catch {
    whole = undefined
  }
  if (Array.isArray(whole)) return { rows: whole.filter(isRecord), parsed: true }
  if (isRecord(whole)) return { rows: [whole], parsed: true }
  const rows: Record<string, unknown>[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const value: unknown = JSON.parse(trimmed)
      if (isRecord(value)) rows.push(value)
    } catch {
      // A warning the engine printed to stdout; skip the line.
    }
  }
  return { rows, parsed: rows.length > 0 }
}

/** Split command output into lines, dropping the trailing empty artifact. */
function toLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

// ---------------------------------------------------------------------------
// Compose file inspection (pure)
// ---------------------------------------------------------------------------

interface Row {
  lineNo: number
  indent: number
  text: string
}

interface CNode {
  /** Mapping key; empty for a `-` sequence item. */
  key: string
  /** Inline scalar text (or the body of a sequence item). */
  inline: string
  lineNo: number
  children: CNode[]
}

/** Strip a whole-line or trailing `#` comment, ignoring `#` inside quotes. */
function stripComment(text: string): string {
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]!))) return text.slice(0, i).trimEnd()
  }
  return text
}

/**
 * Minimal indentation-based YAML reader for Compose documents: mappings,
 * `-` sequences, and inline scalars. Flow collections and long-syntax entries
 * are kept as text, which is all the structural rules below need.
 * @param text - the compose document.
 * @returns the root entries plus the syntax problems found while reading.
 */
function readCompose(text: string): { nodes: CNode[]; errors: string[] } {
  const errors: string[] = []
  const rows: Row[] = []
  const raws = text.split(/\r?\n/)
  for (let index = 0; index < raws.length; index++) {
    const raw = raws[index]!
    const lineNo = index + 1
    if (raw.trim() === '') continue
    const indent = raw.length - raw.trimStart().length
    if (raw.slice(0, indent).includes('\t')) {
      errors.push(`line ${lineNo}: YAML indentation must use spaces, not a tab`)
      continue
    }
    const body = stripComment(raw.trim())
    if (body === '' || body === '---') continue
    rows.push({ lineNo, indent, text: body })
  }
  if (rows.length === 0) return { nodes: [], errors }

  const collect = (start: number, indent: number): CNode[] => {
    const nodes: CNode[] = []
    let i = start
    while (i < rows.length) {
      const row = rows[i]!
      if (row.indent < indent) break
      if (row.indent > indent) {
        errors.push(`line ${row.lineNo}: unexpected indentation at "${row.text}"`)
        i++
        continue
      }
      i++
      const isItem = row.text === '-' || row.text.startsWith('- ')
      const body = isItem ? row.text.slice(1).trim() : row.text
      let key = ''
      let inline = body
      if (!isItem) {
        const sep = body.indexOf(':')
        if (sep < 0 && !body.endsWith(':')) {
          errors.push(`line ${row.lineNo}: expected "key: value", got "${row.text}"`)
          continue
        }
        key = sep < 0 ? body.slice(0, -1).trim() : body.slice(0, sep).trim()
        inline = sep < 0 ? '' : body.slice(sep + 1).trim()
        if (key === '') {
          errors.push(`line ${row.lineNo}: empty mapping key`)
          continue
        }
      }
      let children: CNode[] = []
      if (i < rows.length && rows[i]!.indent > row.indent) {
        const childIndent = rows[i]!.indent
        children = collect(i, childIndent)
        while (i < rows.length && rows[i]!.indent > row.indent) {
          if (rows[i]!.indent < childIndent) {
            errors.push(`line ${rows[i]!.lineNo}: "${rows[i]!.text}" is indented less than its siblings`)
          }
          i++
        }
      }
      nodes.push({ key, inline, lineNo: row.lineNo, children })
    }
    return nodes
  }

  return { nodes: collect(0, rows[0]!.indent), errors }
}

function childOf(node: CNode, key: string): CNode | undefined {
  return node.children.find((child) => child.key === key)
}

function unquote(text: string): string {
  return text.replace(/^\[?\s*["']|["']\s*\]?$/g, '').trim()
}

/** Raw `-` item texts of a node, falling back to a flow `[a, b]` inline value. */
function itemTexts(node: CNode): string[] {
  const items = node.children.filter((child) => child.key === '').map((child) => unquote(child.inline))
  if (items.length === 0 && node.inline.startsWith('[')) {
    const inner = node.inline.slice(1, node.inline.endsWith(']') ? -1 : undefined)
    for (const part of inner.split(',')) {
      if (part.trim() !== '') items.push(unquote(part))
    }
  }
  return items.filter((item) => item !== '')
}

/** Names a `depends_on:` / `networks:` node refers to (block or flow style). */
function referencedNames(node: CNode): string[] {
  const names = node.children.map((child) => (child.key === '' ? child.inline : child.key))
  if (names.length === 0) names.push(...itemTexts(node))
  return names.map(unquote).filter((name) => name !== '')
}

const PORT_RANGE = /^\d{1,5}(-\d{1,5})?$/
const LONG_SYNTAX = /^[A-Za-z_][\w-]*:\s/
const COMPOSE_ROOT_KEYS = ['services', 'networks', 'volumes', 'configs', 'secrets', 'name']
/** Lines `docker_logs` requests when the caller passes tail 0. */
const DEFAULT_TAIL = 100

/** Validate one short-syntax `ports:` entry; returns a problem or undefined. */
function portProblem(entry: string): string | undefined {
  let text = entry.replace(/^\[|\]$/g, '')
  const protocol = text.match(/\/(tcp|udp|sctp)$/)
  if (protocol) text = text.slice(0, -protocol[0].length)
  const parts = text.split(':')
  const numeric = (value: string) => /^\d[\d-]*$/.test(value)
  const usable = (value: string) => PORT_RANGE.test(value) && value.split('-').every((part) => Number(part) >= 1 && Number(part) <= 65535)
  if (parts.length === 1) {
    return numeric(parts[0]!) && usable(parts[0]!) ? undefined : `port "${entry}" is not a number or a range inside 1-65535`
  }
  const container = parts[parts.length - 1]!
  if (!usable(container)) return `port mapping "${entry}" has an unusable container side "${container}"`
  const host = parts.length === 3 ? parts[1]! : parts[0]!
  if (numeric(host) && !usable(host)) return `port mapping "${entry}" has an unusable host side "${host}"`
  return undefined
}

/**
 * Run the structural Compose rules over a document, with no filesystem,
 * subprocess, or network access.
 * @param text - compose YAML text.
 * @returns service names found, blocking errors, and non-blocking warnings.
 */
function inspectCompose(text: string): { services: string[]; errors: string[]; warnings: string[] } {
  const warnings: string[] = []
  if (text.trim() === '') return { services: [], errors: ['the compose document is empty: pass the full YAML text'], warnings }
  const { nodes, errors: syntaxErrors } = readCompose(text)
  const errors = [...syntaxErrors]
  if (errors.length > 0) return { services: [], errors, warnings }

  const top = new Map<string, CNode>()
  for (const node of nodes) {
    if (top.has(node.key)) errors.push(`line ${node.lineNo}: duplicate top-level key "${node.key}"`)
    else top.set(node.key, node)
    if (node.key === 'version') warnings.push('top-level "version" is obsolete in Compose v2 and ignored; consider removing it')
    else if (!COMPOSE_ROOT_KEYS.includes(node.key) && !node.key.startsWith('x-')) {
      warnings.push(`top-level key "${node.key}" is not a Compose section and will be ignored`)
    }
  }

  const servicesNode = top.get('services')
  if (!servicesNode) {
    errors.push('missing top-level "services" section — a Compose file must declare at least one service')
    return { services: [], errors, warnings }
  }
  const services = servicesNode.children.map((node) => node.key).filter((key) => key !== '')
  if (services.length === 0) errors.push('"services" is declared but empty — add at least one service')

  const networkNames = new Set((top.get('networks')?.children ?? []).map((node) => node.key))

  for (const service of servicesNode.children) {
    if (service.children.length === 0 && service.inline === '') {
      errors.push(`service "${service.key}" (line ${service.lineNo}) has no configuration`)
      continue
    }
    if (!childOf(service, 'image') && !childOf(service, 'build')) {
      errors.push(`service "${service.key}": needs "image" or "build" so the container has something to run`)
    }
    if (childOf(service, 'links')) warnings.push(`service "${service.key}": "links" is legacy; rely on "depends_on" and the network for DNS`)
    if (childOf(service, 'container_name') && services.length > 1) {
      warnings.push(`service "${service.key}": sets "container_name", so it cannot be scaled with --scale`)
    }

    const ports = childOf(service, 'ports')
    if (ports) {
      for (const entry of itemTexts(ports)) {
        if (entry === '' || LONG_SYNTAX.test(entry)) continue // long syntax (published:/target:) is not short-form checked
        const problem = portProblem(entry)
        if (problem) warnings.push(`service "${service.key}": ${problem}`)
      }
    }

    const depends = childOf(service, 'depends_on')
    if (depends) {
      for (const ref of referencedNames(depends)) {
        if (ref.includes(':') || ref.includes('=')) continue
        if (!services.includes(ref)) errors.push(`service "${service.key}": depends_on references unknown service "${ref}"`)
      }
    }

    const networks = childOf(service, 'networks')
    if (networks && !childOf(service, 'network_mode') && networkNames.size > 0) {
      for (const ref of referencedNames(networks)) {
        if (ref.includes(':')) continue
        if (!networkNames.has(ref)) warnings.push(`service "${service.key}": network "${ref}" is not declared in the top-level "networks" section`)
      }
    }
  }

  return { services, errors, warnings }
}

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

interface PsValue {
  ok: boolean
  command: string
  exitCode: number
  containers: { id: string; name: string; image: string; state: string; status: string }[]
  message: string
}

interface LogsValue {
  ok: boolean
  command: string
  exitCode: number
  lines: string[]
  truncated: boolean
  errorLines: number
  message: string
}

interface ComposeValue {
  ok: boolean
  command: string
  external: boolean
  exitCode: number
  services: string[]
  errors: string[]
  warnings: string[]
  message: string
}

function renderPs(value: PsValue): string {
  if (!value.ok) return `docker ps failed: ${value.message}\n$ ${value.command}`
  if (value.containers.length === 0) return `No containers matched.\n$ ${value.command}`
  const rows = value.containers.map((row) => `  ${row.id.slice(0, 12).padEnd(13)} ${row.name.padEnd(24)} ${row.image.padEnd(26)} ${row.state.padEnd(10)} ${row.status}`)
  return `${value.containers.length} container(s)\n$ ${value.command}\n${rows.join('\n')}`
}

function renderLogs(value: LogsValue): string {
  if (!value.ok) return `docker logs failed: ${value.message}\n$ ${value.command}`
  const flags = [
    value.truncated ? 'truncated to the configured cap' : '',
    value.errorLines > 0 ? `${value.errorLines} error-like line(s)` : '',
  ].filter((text) => text !== '')
  const head = `${value.lines.length} line(s)${flags.length > 0 ? ` — ${flags.join(', ')}` : ''}`
  return [head, `$ ${value.command}`, ...value.lines.map((line) => `  ${line}`)].join('\n')
}

function renderCompose(value: ComposeValue): string {
  const head = value.ok
    ? `Compose file is valid (${value.services.length} service(s): ${value.services.join(', ') || 'none'}).`
    : `Compose file has ${value.errors.length} blocking problem(s).`
  const body = [
    ...value.errors.map((line) => `- error: ${line}`),
    ...value.warnings.map((line) => `- warning: ${line}`),
  ]
  const tail = value.external ? `$ ${value.command}` : '(local structural check only; set externalCheck to also ask the docker CLI)'
  return [head, ...body, tail].join('\n')
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the Docker tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's docker executable, budgets, and command seam.
 */
export function apply(ctx: Context, config: Config): void {
  const run: RunCommand = config.runCommand ?? defaultRunCommand

  ctx.tools.register(defineTool({
    name: 'docker_ps',
    description:
      'List Docker containers by running `docker ps --format json` and returning ' +
      'structured rows (id, name, image, state, status). Pass all=true to include ' +
      'stopped containers and all=false for running ones only; pass name to keep ' +
      'only containers whose name contains that substring, or an empty string for ' +
      'everything. The result echoes the exact command that ran, so you can ' +
      're-check it by hand.',
    parameters: {
      all: { type: 'boolean', required: true, description: 'Include stopped containers (adds --all); false lists running containers only.' },
      name: { type: 'string', required: true, description: 'Name substring filter (docker ps --filter name=<value>). Pass an empty string to keep every container.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the command ran and its output parsed.' },
          command: { type: 'string', required: true, description: 'The docker command that was executed.' },
          exitCode: { type: 'integer', required: true, description: 'Process exit code; -1 when the executable could not start.' },
          containers: {
            type: 'array',
            required: true,
            description: 'One row per container; empty when nothing matched or the call failed.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: 'Full container id (--no-trunc).' },
                name: { type: 'string', required: true, description: 'Container name(s), comma separated when several.' },
                image: { type: 'string', required: true, description: 'Image the container was created from.' },
                state: { type: 'string', required: true, description: 'running | exited | created | restarting | paused | dead.' },
                status: { type: 'string', required: true, description: 'Docker status line, e.g. "Up 3 hours".' },
              },
            },
          },
          message: { type: 'string', required: true, description: 'Failure detail; empty on success.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderPs(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const filter = (args.name ?? '').trim()
      if (filter) {
        const problem = tokenProblem(filter, 'name')
        if (problem) return { ok: false, command: '', exitCode: -1, containers: [], message: problem }
      }
      const argv = [config.dockerPath, 'ps', '--no-trunc', '--format', 'json']
      if (args.all) argv.push('--all')
      if (filter) argv.push('--filter', `name=${filter}`)
      const result = await run(argv, config.timeoutMs)
      const command = formatArgv(argv)
      if (result.exitCode !== 0) {
        return {
          ok: false,
          command,
          exitCode: result.exitCode,
          containers: [],
          message: firstLine(result.stderr) || firstLine(result.stdout) || `docker ps exited with code ${result.exitCode}`,
        }
      }
      const { rows, parsed } = parseJsonRows(result.stdout)
      if (!parsed) {
        return { ok: false, command, exitCode: result.exitCode, containers: [], message: `could not parse docker ps output: ${firstLine(result.stdout)}` }
      }
      const containers = rows.map((row) => ({
        id: field(row, 'ID'),
        name: field(row, 'Names'),
        image: field(row, 'Image'),
        state: field(row, 'State'),
        status: field(row, 'Status'),
      }))
      return { ok: true, command, exitCode: result.exitCode, containers, message: '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'docker_logs',
    description:
      'Fetch the log tail of one container with `docker logs` and return the lines. ' +
      'container takes a name or id; tail is how many recent lines to request (0 ' +
      'means the default 100, and any value is capped by this plugin\'s ' +
      'maxLogLines); since is a lower bound such as "10m" or an RFC3339 timestamp ' +
      '(empty string for none); grep keeps only lines containing that substring, ' +
      'case-insensitively (empty string for all). Container stdout and stderr are ' +
      'both returned, stdout first, and the result counts error-looking lines.',
    parameters: {
      container: { type: 'string', required: true, description: 'Container name or id, e.g. "api-1".' },
      tail: { type: 'number', required: true, description: 'How many recent lines to request; 0 means the plugin default (100). Values above the configured cap are clamped to it.' },
      since: { type: 'string', required: true, description: 'Lower bound: relative duration ("10m", "1h30m") or an RFC3339 timestamp. Pass an empty string for no bound.' },
      grep: { type: 'string', required: true, description: 'Case-insensitive substring filter applied to the returned lines. Pass an empty string to keep everything.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether `docker logs` succeeded.' },
          command: { type: 'string', required: true, description: 'The docker command that was executed.' },
          exitCode: { type: 'integer', required: true, description: 'Process exit code; -1 when the executable could not start.' },
          lines: {
            type: 'array',
            required: true,
            description: 'Log lines after filtering and the configured cap; empty on failure.',
            items: { type: 'string' },
          },
          truncated: { type: 'boolean', required: true, description: 'Whether lines were dropped to respect the configured cap.' },
          errorLines: { type: 'integer', required: true, description: 'Returned lines matching error/fatal/panic/exception/traceback/failed.' },
          message: { type: 'string', required: true, description: 'Failure detail; empty on success.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderLogs(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const container = args.container.trim()
      const since = (args.since ?? '').trim()
      const grep = (args.grep ?? '').trim().toLowerCase()
      const problems: string[] = []
      const containerProblem = tokenProblem(container, 'container')
      if (containerProblem) problems.push(containerProblem)
      if (since && tokenProblem(since, 'since')) problems.push('since: must be one token such as "10m" or "2024-01-02T03:04:05Z"')
      if (problems.length > 0) {
        return { ok: false, command: '', exitCode: -1, lines: [], truncated: false, errorLines: 0, message: problems.join('; ') }
      }

      const cap = Math.max(1, Math.floor(config.maxLogLines))
      const requested = typeof args.tail === 'number' && Number.isFinite(args.tail) ? Math.floor(args.tail) : 0
      const tail = Math.min(Math.max(1, requested || DEFAULT_TAIL), cap)
      const argv = [config.dockerPath, 'logs', '--tail', String(tail)]
      if (since) argv.push('--since', since)
      argv.push(container)

      const result = await run(argv, config.timeoutMs)
      const command = formatArgv(argv)
      if (result.exitCode !== 0) {
        return {
          ok: false,
          command,
          exitCode: result.exitCode,
          lines: [],
          truncated: false,
          errorLines: 0,
          message: firstLine(result.stderr) || firstLine(result.stdout) || `docker logs exited with code ${result.exitCode}`,
        }
      }
      const merged = [...toLines(result.stdout), ...toLines(result.stderr)]
      const capped = merged.length > cap
      let lines = capped ? merged.slice(merged.length - cap) : merged
      if (grep !== '') lines = lines.filter((line) => line.toLowerCase().includes(grep))
      const errorLines = lines.filter((line) => /error|fatal|panic|exception|traceback|failed/i.test(line)).length
      return { ok: true, command, exitCode: result.exitCode, lines, truncated: capped, errorLines, message: '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'docker_compose_config',
    description:
      'Validate a Docker Compose file. Pass the complete YAML text as content for an ' +
      'instant offline structural check (missing services section, a service with ' +
      'neither image nor build, depends_on naming an unknown service, malformed ' +
      'ports, obsolete version key, undeclared networks). Pass an empty content to ' +
      'have the plugin read the file at path instead. Set externalCheck=true to also ' +
      'run `docker compose -f <path> config --quiet`, which validates the merged, ' +
      'environment-interpolated result and is authoritative.',
    parameters: {
      path: { type: 'string', required: true, description: 'Compose file path, e.g. "compose.yml" or "deploy/docker-compose.yml".' },
      content: { type: 'string', required: true, description: 'Full compose YAML text; an empty string means "read the file at path".' },
      externalCheck: { type: 'boolean', required: true, description: 'Also validate through the docker CLI.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the file passed every check that ran.' },
          command: { type: 'string', required: true, description: 'The docker compose command that ran, or would run with externalCheck.' },
          external: { type: 'boolean', required: true, description: 'Whether the docker CLI was consulted.' },
          exitCode: { type: 'integer', required: true, description: 'Exit code of that command; -1 when it did not run.' },
          services: { type: 'array', required: true, description: 'Service names declared in the file.', items: { type: 'string' } },
          errors: { type: 'array', required: true, description: 'Blocking problems, local checks first then the CLI; empty when ok.', items: { type: 'string' } },
          warnings: { type: 'array', required: true, description: 'Advisories that do not block `docker compose up`.', items: { type: 'string' } },
          message: { type: 'string', required: true, description: 'One-line summary of what was checked.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderCompose(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const composePath = args.path.trim()
      const pathIssue = pathProblem(composePath, 'path')
      if (pathIssue) {
        return { ok: false, command: '', external: false, exitCode: -1, services: [], errors: [pathIssue], warnings: [], message: 'nothing was checked' }
      }

      const argv = [config.dockerPath, 'compose', '-f', composePath, 'config', '--quiet']
      const command = formatArgv(argv)

      let text = args.content ?? ''
      if (text === '') {
        try {
          const { readFileSync } = await import('node:fs')
          text = readFileSync(composePath, 'utf8')
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          return { ok: false, command, external: false, exitCode: -1, services: [], errors: [`cannot read "${composePath}": ${reason}`], warnings: [], message: 'the file could not be read' }
        }
      }

      const report = inspectCompose(text)
      const errors = [...report.errors]
      const warnings = [...report.warnings]
      let external = false
      let exitCode = -1

      if (args.externalCheck) {
        external = true
        const result = await run(argv, config.timeoutMs)
        exitCode = result.exitCode
        if (result.exitCode !== 0) {
          const detail = firstLine(result.stderr) || firstLine(result.stdout) || `docker compose config exited with code ${result.exitCode}`
          errors.push(`docker compose config: ${detail}`)
        }
      }

      const ok = errors.length === 0
      const summary = external
        ? ok ? 'local checks and the docker CLI both passed' : 'see errors'
        : ok ? 'local structural check passed; the docker CLI was not consulted' : 'see errors'
      return { ok, command, external, exitCode, services: report.services, errors, warnings, message: summary }
    },
  }))
}
