# dsh-docker

Docker inspection tools for DeepSeek Harness: a real Cordis host tool plugin that
builds `docker` command lines, runs them through an injectable command seam, and
returns structured, model-readable results.

- `docker_ps` and `docker_logs` talk to the local engine through `docker`.
- `docker_compose_config` validates a Compose file — instantly and offline by
  default, or authoritatively through `docker compose config --quiet` on request.
- No mutating operations are exposed: this plugin starts, stops, or deletes
  nothing. It inspects and validates.

## Installation

```bash
npx -y @deepseek-ai/dsh plugin --profile web add @qingshanjiluo/dsh-docker
```

The bundle ships `cordis.patch.yml`, which inserts the plugin into the profile's
layer stack with the defaults below.

## Configuration

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `dockerPath` | string | `"docker"` | Executable to invoke (`docker`, `podman`, or an absolute path). |
| `timeoutMs` | number | `15000` | Per-command timeout handed to the command seam. |
| `maxLogLines` | number | `400` | Hard cap on the lines `docker_logs` may return. |
| `runCommand` | function | `defaultRunCommand` | Seam `(argv, timeoutMs) => { exitCode, stdout, stderr }`. Defaults to `spawnSync` from `node:child_process` (no shell, 16 MB buffer cap); override it in tests or on hosts without a reachable daemon. Not settable from YAML — it keeps its default there. |

## Tools

Every parameter is declared `required`, so "no filter" is an explicit empty
string or `0` rather than a missing field — the model always sees the full call.

| Tool | Arguments (all required) | Returns |
|------|--------------------------|---------|
| `docker_ps` | `all` (boolean: include stopped containers), `name` (string: name substring filter, `""` for none) | `{ ok, command, exitCode, containers[{id,name,image,state,status}], message }` from `docker ps --no-trunc --format json`, tolerating both line-delimited and array engine output. |
| `docker_logs` | `container` (name or id), `tail` (`0` = the default 100, clamped to `maxLogLines`), `since` (`"10m"` or RFC3339, `""` for no bound), `grep` (case-insensitive substring, `""` to keep all) | `{ ok, command, exitCode, lines, truncated, errorLines, message }` from `docker logs --tail N [--since X] <container>`; container stdout and stderr are merged (stdout first), then filtered and capped. |
| `docker_compose_config` | `path` (compose file), `content` (full YAML text; `""` means read `path` from disk), `externalCheck` (also ask the docker CLI) | `{ ok, command, external, exitCode, services, errors, warnings, message }`. Structural rules: `services` present and non-empty, every service has `image` or `build`, `depends_on` resolves to declared services, short-syntax `ports` are numeric and in 1-65535, and tabs / duplicate or unknown top-level keys / obsolete `version` / undeclared networks are reported. With `externalCheck` it also runs `docker compose -f <path> config --quiet`. |

Each tool echoes the exact command it ran (or would run), and rejects model input
that could smuggle an option into docker — values may not start with `-` or carry
newlines or, for single tokens, whitespace — before any process is spawned.

## Development

```bash
npm install --no-audit --no-fund
npx tsc --noEmit          # types
npm run build             # lib/index.js + lib/index.d.ts
npx vitest run            # behaviour tests (fake command seam, no docker needed)
node scripts/load-smoke.mjs   # loads the built artifact and registers the tools
```

## License

MIT
