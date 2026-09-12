/**
 * Loads the built artifact and asserts it exports the Cordis function-plugin
 * face the harness loader requires, then mounts it against a fake command seam
 * so no docker binary is ever spawned. Run after `npm run build`.
 * @module
 */
import assert from 'node:assert/strict'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

assert.equal(mod.name, 'dsh-docker', 'plugin name export')
assert.deepEqual(mod.inject, ['tools'], 'inject declares the tools service')
assert.equal(typeof mod.apply, 'function', 'apply is a function')
assert.ok(mod.Config, 'Config schema export present')
assert.equal(typeof mod.defaultRunCommand, 'function', 'the command seam default is exported')

// Defaults come from the schema itself; only the seam is swapped for a stub.
const config = { ...mod.Config({}), runCommand: () => ({ exitCode: 0, stdout: '', stderr: '' }) }
assert.equal(config.dockerPath, 'docker', 'dockerPath default')
assert.equal(config.maxLogLines, 400, 'maxLogLines default')

const registered = []
mod.apply({ tools: { register: (def) => registered.push(def) } }, config)
assert.deepEqual(
  registered.map((tool) => tool.name).sort(),
  ['docker_compose_config', 'docker_logs', 'docker_ps'],
  'the three documented tools register',
)
for (const tool of registered) {
  assert.ok(tool.description?.length > 40, `${tool.name} has a model-facing description`)
  assert.ok(tool.output?.schema, `${tool.name} declares an output schema`)
  assert.equal(typeof tool.execute, 'function', `${tool.name} is executable`)
}

// Smoke one real call path through the built artifact: docker_ps against a stub.
const ps = registered.find((tool) => tool.name === 'docker_ps')
const value = await ps.execute({ all: true, name: '' }, {})
assert.equal(value.ok, true, 'docker_ps succeeds against the stub')
assert.deepEqual(value.containers, [], 'empty engine output yields no containers')
assert.equal(value.command, 'docker ps --no-trunc --format json --all', 'command text is reported')

// The seam is genuinely injectable: a stub that reports one container flows through.
const stubbed = []
mod.apply({ tools: { register: (def) => stubbed.push(def) } }, {
  ...config,
  runCommand: () => ({ exitCode: 0, stdout: '{"ID":"aa","Names":"web","Image":"nginx","State":"running","Status":"Up"}', stderr: '' }),
})
const seen = await stubbed.find((tool) => tool.name === 'docker_ps').execute({ all: false, name: 'web' }, {})
assert.equal(seen.containers.length, 1, 'injected seam output is parsed')
assert.deepEqual(seen.containers[0], { id: 'aa', name: 'web', image: 'nginx', state: 'running', status: 'Up' })
assert.equal(seen.command, `docker ps --no-trunc --format json --filter name=web`)

console.log('load-smoke: ok —', registered.length, 'tools registered from built artifact')
