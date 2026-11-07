# @hosimitu/dsh-plan-model-sync

Run plan mode on a high-intelligence model and return to the model you were
using before `/plan` once planning ends.

DeepSeek Harness has one model route per Session. Plan mode does not change it on
its own, so a long planning conversation and the code it later produces run on
the same model. This plugin mirrors plan mode onto the route: entering plan mode
selects a planning route you name, and leaving it restores whatever route was in
force before.

## Install

From a checkout:

```sh
dsh plugin --profile web add /path/to/dsh-plan-model-sync
```

From GitHub (sources only — see [Build](#build)):

```sh
dsh plugin --profile web add github:hosimitu/dsh-plan-model-sync
```

## Configure

Enable plan mode in your profile's `cordis.patch.yml` — the Web bundle disables
it by default — then add this plugin's row. A row that does not exist yet needs
an `insert` block; a bare `id` would only override an existing row.

```yaml
- id: plan-mode
  disabled: false

- insert:
    - id: plan-model-sync
      name: '@hosimitu/dsh-plan-model-sync'
      config:
        planProvider: opencode-go
        planModel: gemini-4-argon
```

| Field | Default | Meaning |
|---|---|---|
| `planProvider` | required | Provider route used while plan mode is active |
| `planModel` | required | Model id on `planProvider` used while plan mode is active |
| `verbose` | `true` | Log why a switch was skipped or completed |

Both route fields are required and validated at load: a missing or blank value
fails the plugin rather than silently inheriting a model the deployment never
named.

The planning route is checked against the provider's catalog on startup and
again whenever `llm/adapters-updated` fires. A route the catalog does not list is
never selected, so a typo keeps the current model instead of routing requests to
a model that would fail.

## Behavior

Entering plan mode records a `model/selection` for the planning route, so the
model-switch notice names the change in the conversation. Leaving plan mode
records the saved route the same way. Neither direction writes anything when the
Session already runs the target route, so a Session that starts on the planning
route records nothing at all.

### When the switch lands

The switch lands on the **next** step, not the one in flight. Plan mode's own
`/plan off` and its approved exit append `plan/mode` at the next accepted in-turn
pre-step, so the step that carries the exit tool call still runs on the planning
route. Treat the first implementation step after an approval as a planning-route
step.

The selection itself is recorded on a microtask rather than inline.
`session/event` publishes while the `plan/mode` append is still in flight
(`entry.appending === true`), and a nested `session.append` in that window throws
`session append cannot reenter while another append is being published`. A
microtask clears the in-flight append and still precedes the next turn's
`preStep()`, so the observable ordering is unchanged.

### What is deliberately not restored

The route to return to is remembered in memory only. A resumed Session replays
its log without publishing `session/event`, and a reloaded plugin starts with no
memory, so both stay on whatever route the Session already has — deliberately
the safe direction, since a wrong guess would move a Session onto a route its
user did not choose. Re-issue `/plan` after a restart to re-sync.

Subagent Sessions are never touched. A subagent runs under its parent's
delegation and inherits no plan mode, so moving it would silently change what the
parent's task costs.

## Build

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
```

`lib/` is committed, so a git install works without running a build script.
`tsdown` emits both `lib/index.js` and `lib/index.d.ts` in one pass.

If you prefer to build at install time instead, `prepare` is not defined on
purpose: pnpm refuses to run a git dependency's build script until the installing
user allowlists it in their profile's `pnpm-workspace.yaml`. Shipping `lib/`
avoids asking for that permission.

## Dependencies

Peer dependencies are the harness packages this plugin must share with the host.
Declare them as peers so the installation's copy is the one the plugin imports;
the devDependencies copy serves the type checker and the standalone tests.

## License

MIT
