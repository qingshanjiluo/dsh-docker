import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply, Config, defaultRunCommand, inject, name, type CommandResult } from '../src/index.ts'

interface RegisteredTool {
  name: string
  description: string
  parameters: { properties: Record<string, unknown>; required: string[] }
  output: { schema: unknown; render(args: any, value: any): { type: string; text: string }[] }
  isConcurrencySafe?(args: unknown): boolean
  execute(args: any, exec: any): Promise<any>
}

interface MountOptions {
  dockerPath?: string
  timeoutMs?: number
  maxLogLines?: number
  /** canned docker output for every command the tool runs */
  stdout?: string
  stderr?: string
  exitCode?: number
}

/**
 * Mount the plugin against a fake command seam and record every argv it asks
 * for. No real process is ever spawned: `runCommand` is replaced wholesale.
 * @param options - config overrides plus the canned docker output.
 * @returns the registered tools, the recorded calls, and a lookup helper.
 */
function mount(options: MountOptions = {}) {
  const registered: RegisteredTool[] = []
  const calls: { argv: readonly string[]; timeoutMs: number }[] = []
  const ctx = { tools: { register: (def: RegisteredTool) => registered.push(def) } }
  const canned: CommandResult = {
    exitCode: options.exitCode ?? 0,
    stdout: options.stdout ?? '',
    stderr: options.stderr ?? '',
  }
  const config: Record<string, unknown> = { ...Config({}) }
  if (options.dockerPath !== undefined) config.dockerPath = options.dockerPath
  if (options.timeoutMs !== undefined) config.timeoutMs = options.timeoutMs
  if (options.maxLogLines !== undefined) config.maxLogLines = options.maxLogLines
  config.runCommand = (argv: readonly string[], timeoutMs: number) => {
    calls.push({ argv, timeoutMs })
    return canned
  }
  // The plugin only reads ctx.tools, so a one-method stub is the real surface.
  apply(ctx as never, config as never)
  return {
    calls,
    tools: registered,
    tool: (toolName: string) => registered.find((tool) => tool.name === toolName)!,
  }
}

// `defineTool` validates arguments against the parameter schema, so every call
// spells out all required parameters; these builders keep the cases readable.
const psArgs = (overrides: Record<string, unknown> = {}) => ({ all: false, name: '', ...overrides })
const logArgs = (overrides: Record<string, unknown> = {}) => ({ container: 'api', tail: 0, since: '', grep: '', ...overrides })
const composeArgs = (overrides: Record<string, unknown> = {}) => ({ path: 'compose.yml', content: '', externalCheck: false, ...overrides })

const VALID_COMPOSE = [
  'name: demo',
  'services:',
  '  web:',
  '    image: nginx:1.27',
  '    ports:',
  '      - "8080:80"',
  '    depends_on:',
  '      - db',
  '    networks:',
  '      - backend',
  '  db:',
  '    image: postgres:16',
  '    networks:',
  '      - backend',
  'networks:',
  '  backend:',
  '',
].join('\n')

describe('dsh-docker plugin contract', () => {
  it('exports the loader plugin face', () => {
    expect(name).toBe('dsh-docker')
    expect(inject).toEqual(['tools'])
    expect(typeof apply).toBe('function')
    expect(Config).toBeInstanceOf(Object)
  })

  it('registers the three documented tools', () => {
    expect(mount().tools.map((tool) => tool.name).sort())
      .toEqual(['docker_compose_config', 'docker_logs', 'docker_ps'])
  })

  it('gives every tool a model-facing description, output schema, and renderer', () => {
    for (const tool of mount().tools) {
      expect(tool.description.length).toBeGreaterThan(60)
      expect(tool.output.schema).toBeTypeOf('object')
      expect(typeof tool.output.render).toBe('function')
    }
  })

  it('marks every declared parameter required and classifies all tools concurrency-safe', () => {
    const sampleArgs: Record<string, Record<string, unknown>> = {
      docker_ps: psArgs(),
      docker_logs: logArgs(),
      docker_compose_config: composeArgs({ content: VALID_COMPOSE }),
    }
    for (const tool of mount().tools) {
      expect(Object.keys(tool.parameters.properties).sort()).toEqual([...tool.parameters.required].sort())
      expect(tool.parameters.required.length).toBeGreaterThan(0)
      expect(tool.isConcurrencySafe?.(sampleArgs[tool.name])).toBe(true)
    }
  })

  it('supplies the spawnSync seam by default and honours explicit config', () => {
    const defaults = Config({})
    expect(defaults.dockerPath).toBe('docker')
    expect(defaults.timeoutMs).toBe(15000)
    expect(defaults.maxLogLines).toBe(400)
    expect(defaults.runCommand).toBe(defaultRunCommand)
    const explicit = Config({ dockerPath: 'podman', timeoutMs: 900, maxLogLines: 12 })
    expect([explicit.dockerPath, explicit.timeoutMs, explicit.maxLogLines]).toEqual(['podman', 900, 12])
  })

  it('refuses to spawn anything for an empty argv', () => {
    expect(defaultRunCommand([], 10)).toEqual({ exitCode: -1, stdout: '', stderr: 'nothing to run: the command was empty' })
  })

  it('rejects arguments that violate the declared schema', async () => {
    await expect(mount().tool('docker_ps').execute({}, {} as never)).rejects.toThrow()
  })
})

describe('docker_ps', () => {
  const rows = [
    '{"ID":"abc123def456","Names":"api-1","Image":"node:22","State":"running","Status":"Up 3 hours","Ports":"0.0.0.0:3000->3000/tcp"}',
    '{"ID":"ffee00112233","Names":"db-1","Image":"postgres:16","State":"exited","Status":"Exited (0) 2 minutes ago"}',
  ].join('\n')

  it('parses line-delimited engine JSON into container rows', async () => {
    const host = mount({ stdout: rows })
    const result = await host.tool('docker_ps').execute(psArgs({ all: true }), {} as never)
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.message).toBe('')
    expect(result.containers).toEqual([
      { id: 'abc123def456', name: 'api-1', image: 'node:22', state: 'running', status: 'Up 3 hours' },
      { id: 'ffee00112233', name: 'db-1', image: 'postgres:16', state: 'exited', status: 'Exited (0) 2 minutes ago' },
    ])
    expect(host.calls[0]!.argv).toEqual(['docker', 'ps', '--no-trunc', '--format', 'json', '--all'])
    expect(host.calls[0]!.timeoutMs).toBe(15000)
    expect(result.command).toBe('docker ps --no-trunc --format json --all')
  })

  it('parses the legacy JSON array form and applies a name filter', async () => {
    const host = mount({ stdout: '[{"id":"1","names":"api","image":"node","state":"running","status":"Up"}]' })
    const result = await host.tool('docker_ps').execute(psArgs({ name: 'api' }), {} as never)
    expect(host.calls[0]!.argv).toEqual(['docker', 'ps', '--no-trunc', '--format', 'json', '--filter', 'name=api'])
    expect(result.containers).toEqual([{ id: '1', name: 'api', image: 'node', state: 'running', status: 'Up' }])
  })

  it('reports no containers for empty engine output', async () => {
    const result = await mount().tool('docker_ps').execute(psArgs(), {} as never)
    expect(result).toMatchObject({ ok: true, containers: [] })
  })

  it('turns a daemon error into a failed result carrying the engine message', async () => {
    const host = mount({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n' })
    const result = await host.tool('docker_ps').execute(psArgs({ all: true }), {} as never)
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.containers).toEqual([])
    expect(result.message).toContain('Cannot connect to the Docker daemon')
    expect(host.calls[0]!.argv[0]).toBe('docker')
  })

  it('fails closed on output it cannot parse', async () => {
    const result = await mount({ stdout: 'not json at all' }).tool('docker_ps').execute(psArgs(), {} as never)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('could not parse')
  })

  it('rejects option-injection and whitespace filters before running anything', async () => {
    const host = mount()
    const result = await host.tool('docker_ps').execute(psArgs({ name: '--format table' }), {} as never)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('must not start with "-"')
    expect(host.calls).toEqual([])
  })

  it('uses the configured executable and renders a summary for the model', async () => {
    const host = mount({ stdout: rows, dockerPath: 'podman' })
    const tool = host.tool('docker_ps')
    const result = await tool.execute(psArgs(), {} as never)
    expect(host.calls[0]!.argv[0]).toBe('podman')
    expect(tool.output.render(psArgs(), result)[0]!).toMatchObject({ type: 'text' })
    expect(tool.output.render(psArgs(), result)[0]!.text).toContain('2 container(s)')
  })
})

describe('docker_logs', () => {
  it('builds a tail command and returns lines plus an error count', async () => {
    const host = mount({ stdout: 'ready\nGET /health 200\nError: connection reset by peer\n' })
    const tool = host.tool('docker_logs')
    const result = await tool.execute(logArgs({ container: 'api-1' }), {} as never)
    expect(host.calls[0]!.argv).toEqual(['docker', 'logs', '--tail', '100', 'api-1'])
    expect(result).toMatchObject({
      ok: true,
      lines: ['ready', 'GET /health 200', 'Error: connection reset by peer'],
      truncated: false,
      errorLines: 1,
      message: '',
    })
    expect(tool.output.render(logArgs(), result)[0]!.text).toContain('3 line(s)')
  })

  it('merges container stderr after stdout', async () => {
    const result = await mount({ stdout: 'out-1\n', stderr: 'err-1\n' }).tool('docker_logs').execute(logArgs(), {} as never)
    expect(result.lines).toEqual(['out-1', 'err-1'])
  })

  it('passes since through and clamps tail to the configured cap', async () => {
    const host = mount({ maxLogLines: 20, timeoutMs: 900, stdout: 'x' })
    const result = await host.tool('docker_logs').execute(logArgs({ tail: 5000, since: '10m' }), {} as never)
    expect(host.calls[0]!.argv).toEqual(['docker', 'logs', '--tail', '20', '--since', '10m', 'api'])
    expect(host.calls[0]!.timeoutMs).toBe(900)
    expect(result.ok).toBe(true)
  })

  it('truncates oversized logs to the newest lines', async () => {
    const many = Array.from({ length: 50 }, (_, index) => `line ${index}`).join('\n')
    const result = await mount({ maxLogLines: 5, stdout: many }).tool('docker_logs').execute(logArgs({ tail: 50 }), {} as never)
    expect(result.truncated).toBe(true)
    expect(result.lines).toEqual(['line 45', 'line 46', 'line 47', 'line 48', 'line 49'])
  })

  it('filters with grep before counting error lines', async () => {
    const stdout = ['info one', 'ERROR db down', 'info two', 'error rate high'].join('\n')
    const result = await mount({ stdout }).tool('docker_logs').execute(logArgs({ grep: 'error' }), {} as never)
    expect(result.lines).toEqual(['ERROR db down', 'error rate high'])
    expect(result.errorLines).toBe(2)
  })

  it('reports a missing container as a failure', async () => {
    const result = await mount({ exitCode: 125, stderr: 'Error response from daemon: No such container: nope\n' })
      .tool('docker_logs').execute(logArgs({ container: 'nope' }), {} as never)
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(125)
    expect(result.message).toContain('No such container')
    expect(result.lines).toEqual([])
  })

  it('validates arguments before invoking docker', async () => {
    const host = mount()
    const result = await host.tool('docker_logs').execute(logArgs({ container: 'two words' }), {} as never)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('must not contain whitespace')
    expect(host.calls).toEqual([])
  })
})

describe('docker_compose_config', () => {
  const toolOf = (host: ReturnType<typeof mount>) => host.tool('docker_compose_config')

  it('validates a well-formed file offline without consulting the CLI', async () => {
    const host = mount()
    const result = await toolOf(host).execute(composeArgs({ content: VALID_COMPOSE }), {} as never)
    expect(result).toMatchObject({
      ok: true,
      external: false,
      exitCode: -1,
      services: ['web', 'db'],
      errors: [],
      warnings: [],
      message: 'local structural check passed; the docker CLI was not consulted',
    })
    expect(result.command).toBe('docker compose -f compose.yml config --quiet')
    expect(host.calls).toEqual([])
  })

  it('flags a missing services section and an empty document', async () => {
    const missing = await toolOf(mount()).execute(composeArgs({ content: 'networks:\n  backend:\n' }), {} as never)
    expect(missing.ok).toBe(false)
    expect(missing.errors.join('\n')).toContain('missing top-level "services"')

    const noServices = await toolOf(mount()).execute(composeArgs({ content: 'services:\n' }), {} as never)
    expect(noServices.errors.join('\n')).toContain('"services" is declared but empty')
  })

  it('requires image or build, resolves depends_on, and checks both port sides', async () => {
    const content = [
      'services:',
      '  web:',
      '    ports:',
      '      - "808080:80"',
      '      - "900:notaport"',
      '      - target: 80',
      '        published: 8080',
      '    depends_on:',
      '      - bass',
      '      - db: { condition: service_healthy }',
      '  cache:',
      '    image: redis',
      '',
    ].join('\n')
    const result = await toolOf(mount()).execute(composeArgs({ content }), {} as never)
    expect(result.ok).toBe(false)
    expect(result.services).toEqual(['web', 'cache'])
    expect(result.errors.join('\n')).toContain('needs "image" or "build"')
    expect(result.errors.join('\n')).toContain('depends_on references unknown service "bass"')
    expect(result.errors.join('\n')).not.toContain('"db"')
    // The long-syntax entry is left to the CLI, so only the two bad short forms warn.
    const warnings = result.warnings.join('\n')
    expect(warnings).toContain('unusable host side')
    expect(warnings).toContain('unusable container side')
    expect(result.warnings).toHaveLength(2)
  })

  it('warns about obsolete and unknown top-level keys but accepts x- extensions', async () => {
    const content = [
      'version: "3.9"',
      'x-meta:',
      '  owner: platform',
      'widget: true',
      'services:',
      '  web:',
      '    build: .',
      '',
    ].join('\n')
    const result = await toolOf(mount()).execute(composeArgs({ content }), {} as never)
    expect(result.ok).toBe(true)
    expect(result.services).toEqual(['web'])
    const warnings = result.warnings.join('\n')
    expect(warnings).toContain('"version" is obsolete')
    expect(warnings).toContain('"widget" is not a Compose section')
    expect(warnings).not.toContain('x-meta')
  })

  it('catches tab indentation and undeclared networks', async () => {
    const tabs = await toolOf(mount()).execute(composeArgs({ content: 'services:\n\tweb:\n\t  image: nginx\n' }), {} as never)
    expect(tabs.ok).toBe(false)
    expect(tabs.errors.join('\n')).toContain('not a tab')

    const networks = await toolOf(mount()).execute(composeArgs({ content: [
      'services:',
      '  web:',
      '    image: nginx',
      '    networks:',
      '      - frontend',
      'networks:',
      '  backend:',
      '',
    ].join('\n') }), {} as never)
    expect(networks.ok).toBe(true)
    expect(networks.warnings.join('\n')).toContain('network "frontend" is not declared')
  })

  it('runs the authoritative CLI check through the seam when asked', async () => {
    const ok = mount({ stdout: '' })
    const passed = await toolOf(ok).execute(composeArgs({ content: VALID_COMPOSE, externalCheck: true }), {} as never)
    expect(passed).toMatchObject({ ok: true, external: true, exitCode: 0 })
    expect(ok.calls[0]!.argv).toEqual(['docker', 'compose', '-f', 'compose.yml', 'config', '--quiet'])

    const failing = mount({ exitCode: 1, stderr: 'yaml: line 4: services.web must provide either "image" or "build"\n' })
    const failed = await toolOf(failing).execute(composeArgs({ content: VALID_COMPOSE, externalCheck: true }), {} as never)
    expect(failed.ok).toBe(false)
    expect(failed.errors.join('\n')).toContain('docker compose config: yaml: line 4')
    expect(failed.exitCode).toBe(1)
    expect(failed.message).toBe('see errors')
  })

  it('reads the file from disk when content is empty', async () => {
    const result = await toolOf(mount()).execute(composeArgs({ path: 'no-such-dir/definitely-absent-compose.yml' }), {} as never)
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('cannot read')
    expect(result.message).toBe('the file could not be read')
  })

  it('rejects an empty path before doing any work', async () => {
    const host = mount()
    const result = await toolOf(host).execute(composeArgs({ path: '  ', content: VALID_COMPOSE }), {} as never)
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(['path: must not be empty'])
    expect(host.calls).toEqual([])
  })

  it('renders the verdict for the model', async () => {
    const tool = toolOf(mount())
    const broken = await tool.execute(composeArgs({ content: 'services:\n  web:\n    image: nginx\n  other:\n    depends_on:\n      - web\n' }), {} as never)
    expect(broken.errors.join('\n')).toContain('service "other"')
    expect(tool.output.render(composeArgs(), broken)[0]!.text).toContain('1 blocking problem')

    const good = await tool.execute(composeArgs({ content: VALID_COMPOSE }), {} as never)
    expect(tool.output.render(composeArgs(), good)[0]!.text).toContain('Compose file is valid (2 service(s): web, db)')
  })
})

describe('canonical output contract', () => {
  // The registry validates every returned value against `output.schema`, so a
  // drift between what a tool returns and what it declares fails at runtime.
  const cases: { tool: string; host: () => ReturnType<typeof mount>; args: Record<string, unknown> }[] = [
    { tool: 'docker_ps', host: () => mount({ stdout: '{"ID":"1","Names":"web","Image":"nginx","State":"running","Status":"Up"}' }), args: psArgs() },
    { tool: 'docker_ps', host: () => mount({ exitCode: 1, stderr: 'boom' }), args: psArgs({ all: true }) },
    { tool: 'docker_logs', host: () => mount({ stdout: 'one\ntwo\n' }), args: logArgs({ tail: 5 }) },
    { tool: 'docker_logs', host: () => mount({ exitCode: 125, stderr: 'no such container' }), args: logArgs() },
    { tool: 'docker_compose_config', host: () => mount(), args: composeArgs({ content: VALID_COMPOSE }) },
    { tool: 'docker_compose_config', host: () => mount({ exitCode: 1, stderr: 'bad file' }), args: composeArgs({ content: 'services:\n  web:\n    image: nginx\n', externalCheck: true }) },
    { tool: 'docker_compose_config', host: () => mount(), args: composeArgs({ path: '  ' }) },
  ]

  for (const [index, testCase] of cases.entries()) {
    it(`case ${index}: ${testCase.tool} returns a value matching its declared schema`, async () => {
      const host = testCase.host()
      const value = await host.tool(testCase.tool).execute(testCase.args, {} as never)
      expect(validateJsonSchemaValue(host.tool(testCase.tool).output.schema as never, value, '')).toEqual([])
    })
  }
})
