# CLI (`pointer`)

`packages/cli` is a thin HTTP client of the Pointer server API — it holds no backend logic, so every command
doubles as a live smoke test of a running server. Config lives at `~/.config/pointer/config.json`
(override with `POINTER_CONFIG`); the API base can also come from `POINTER_API_URL`.

```bash
cd packages/cli && bun install
alias pointer='bun run /path/to/packages/cli/src/index.ts'
```

## Commands

| Command | Purpose |
|---|---|
| `pointer config [--api-url URL]` | Show config, or set the API base URL |
| `pointer bootstrap --email E --password P [--name N] [--instance NAME]` | Register the first user (→ admin), ensure a default group, create an instance, and mint a `ptr_` key — all saved to config |
| `pointer login --email E --password P` | Log in and save the JWT |
| `pointer whoami` | Show the logged-in user |
| `pointer provider manifests` | List available provider manifests |
| `pointer provider list` | List active providers |
| `pointer provider add <manifestId> --key KEY [--label L]` | Add a provider from a manifest (triggers model sync) |
| `pointer models` | List models available to the saved `ptr_` key |
| `pointer complete <model> [prompt]` | One-shot completion (non-streaming) |
| `pointer chat <model> [prompt]` | Streaming completion (prints tokens as they arrive) |

`complete`/`chat` read the prompt from stdin if not passed as an argument.

The CLI is a standalone administration client. Managed host automation must use
the versioned `/api/platform/v1` HTTP contract with host-issued assertions,
idempotency, and credential-delivery acknowledgement. `bootstrap` and `login`
are unavailable in managed mode; the CLI is not a substitute platform identity
or lifecycle channel.

## Typical first-run

```bash
pointer config --api-url http://localhost:4000
pointer bootstrap --email admin@example.com --password 'strong-pw'
pointer provider add deepinfra --key <deepinfra-key>
# add a model to your default group via the API/Pointer web, then:
pointer models
pointer chat "Llama 3.1 8B" "Explain what an API gateway is."
```
