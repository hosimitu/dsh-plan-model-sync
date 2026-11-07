/**
 * Keep a Session's model in step with its plan mode: while plan mode is active
 * the Session runs a deployment-chosen planning route, and when plan mode ends
 * it returns to the route that was in force before plan mode began.
 *
 * The switch is driven by the log-only `plan/mode` event rather than by a hook:
 * `agent/pre-step` runs after the step's model selection is already captured, so
 * a listener there could not affect the step it sees. `Session.append` publishes
 * `session/event` synchronously from `commit()`.
 *
 * That synchronous publication also constrains how the switch is written: the
 * append is still being published while this observer runs
 * (`entry.appending === true`), so a nested `session.append` throws "session
 * append cannot reenter". Every `agent.model.select()` therefore runs on a
 * microtask, which is late enough to escape the in-flight append and still early
 * enough to precede the next turn's `preStep()`.
 *
 * The route to return to is remembered in memory only. A resumed Session
 * replays its log without publishing `session/event`, and a reloaded plugin
 * starts with no memory, so both stay on whatever route the Session already
 * has — deliberately the safe direction, since a wrong guess would move a
 * Session onto a route its user did not choose.
 *
 * @module @hosimitu/dsh-plan-model-sync
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: this package's module augmentation declares the log-only
// `plan/mode` event this plugin observes.
import type {} from '@deepseek-ai/dsh-plan-mode'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'plan-model-sync'

/** Host services required before the first `plan/mode` can be observed. */
export const inject = ['agents', 'llm', 'sessions']

/** Deployment configuration: the planning route, and logging verbosity. */
export interface Config {
  /** Provider route to use while plan mode is active. */
  planProvider: string
  /** Model id on {@link planProvider} to use while plan mode is active. */
  planModel: string
  /** Log why a switch was skipped. Defaults to true. */
  verbose?: boolean
}

/**
 * Validate deployment configuration.
 *
 * Both route fields are required: without them there is no planning route to
 * switch to, and inheriting an arbitrary default would silently pick a model
 * the deployment never named.
 *
 * @param config - raw plugin config.
 * @returns the validated config with `verbose` resolved.
 */
export function resolveConfig(config: Config): Required<Config> {
  return {
    planProvider: requiredField(config, 'planProvider'),
    planModel: requiredField(config, 'planModel'),
    verbose: config.verbose ?? true,
  }
}

/** Read one required non-blank string field. */
function requiredField(config: Config, key: 'planProvider' | 'planModel'): string {
  const value = (config as Partial<Config>)[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`PlanModelSyncConfig needs a non-empty string \`${key}\``)
  }
  return value.trim()
}

/** Compare two selections by route, ignoring reasoning effort. */
function sameRoute(left: ModelSelection, right: ModelSelection): boolean {
  return left.provider === right.provider && left.model === right.model
}

/**
 * Whether this Agent exposes the model controller this plugin drives.
 *
 * `Agent.model` was added after the first releases that carried the log-only
 * `plan/mode` event, so a host can deliver that event to an Agent with no
 * controller. Narrowing at the boundary keeps the rest of the observer free of
 * optional chaining while making the plugin inert instead of throwing there.
 *
 * @param agent - the live Agent for one Session.
 * @returns true when `current()` and `select()` are both callable.
 */
function hasModelController(agent: Agent): agent is Agent & {
  model: { current(): Readonly<ModelSelection> | undefined, select(selection: Readonly<ModelSelection>): void }
} {
  const model = (agent as { model?: unknown }).model
  if (typeof model !== 'object' || model === null) return false
  const candidate = model as { current?: unknown, select?: unknown }
  return typeof candidate.current === 'function' && typeof candidate.select === 'function'
}

/** What the observer needs from the Host, passed explicitly so it stays testable. */
export interface SyncDeps {
  /** Look up the live Agent for one Session id. */
  agentOf(id: Session['id']): Agent | undefined
  /** Log a skipped or completed switch. */
  log(level: 'info' | 'warn', message: string): void
  /**
   * Whether the planning route may be selected. `undefined` means the catalog
   * has not answered yet, so no switch is attempted.
   */
  planningRouteUsable(): boolean | undefined
}

/**
 * Build the `session/event` observer that mirrors plan mode onto the route.
 *
 * @param config - validated config.
 * @param deps - Host lookups and logging.
 * @returns the observer to register on `session/event`.
 */
export function createPlanModelSync(
  config: Required<Config>,
  deps: SyncDeps,
): (session: Session, event: SessionEvent) => void {
  const planningRoute: ModelSelection = { provider: config.planProvider, model: config.planModel }
  /** Route in force when plan mode began, per top-level Session. */
  const beforePlan = new WeakMap<Session, ModelSelection>()
  const say = (level: 'info' | 'warn', message: string): void => {
    if (config.verbose) deps.log(level, message)
  }
  /**
   * Record a selection once the in-flight append has settled.
   *
   * The append being published is the very `plan/mode` that triggered this
   * observer, so selecting inline would reenter the Session and throw. A
   * failure here is logged rather than propagated: it lands on a microtask,
   * outside any caller that could handle it, and an unhandled rejection would
   * be worse than one missed switch.
   */
  const selectDeferred = (agent: Agent, selection: ModelSelection): void => {
    queueMicrotask(() => {
      try {
        agent.model.select(selection)
      } catch (error: unknown) {
        deps.log('warn', `plan-model-sync: could not record the model switch: ${String(error)}`)
      }
    })
  }

  return (session, event) => {
    if (event.type !== 'plan/mode') return
    // A subagent's Session runs its own task under its parent's delegation; it
    // inherits no plan mode and must not be moved onto the planning route.
    if (session.header.origin === 'subagent') return
    const agent = deps.agentOf(session.id)
    if (agent === undefined) {
      say('info', 'plan-model-sync: no live Agent for this Session; leaving the model alone')
      return
    }
    // `Agent.model` arrived after the first releases that carried `plan/mode`.
    // A host without it is not an error to report once per flip: the plugin
    // simply has nothing to drive there, so it stays silent and inert.
    if (!hasModelController(agent)) {
      say('info', 'plan-model-sync: this Agent exposes no model controller; leaving the model alone')
      return
    }

    if (event.data.active) {
      if (beforePlan.has(session)) {
        say('info', 'plan-model-sync: already holding a route to restore; not overwriting')
        return
      }
      const current = agent.model.current()
      if (current === undefined) {
        say('info', 'plan-model-sync: no current route to restore; leaving the model alone')
        return
      }
      if (sameRoute(current, planningRoute)) {
        // Entering plan mode from the planning route leaves nothing to restore.
        return
      }
      const usable = deps.planningRouteUsable()
      if (usable !== true) {
        if (usable === false) {
          say('info', 'plan-model-sync: planning route unavailable; plan mode keeps the current model')
        }
        return
      }
      beforePlan.set(session, current)
      selectDeferred(agent, planningRoute)
      say('info', `plan-model-sync: ${current.provider}/${current.model} → `
        + `${planningRoute.provider}/${planningRoute.model} for plan mode`)
      return
    }

    const saved = beforePlan.get(session)
    if (saved === undefined) return
    beforePlan.delete(session)
    selectDeferred(agent, saved)
    say('info', `plan-model-sync: plan mode ended; restored ${saved.provider}/${saved.model}`)
  }
}

/**
 * Mirror plan mode onto the Session's model route.
 *
 * @param ctx - Host plugin context.
 * @param config - planning route and logging verbosity.
 * @returns nothing; the observation lives with the plugin fiber.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)

  // The catalog read is asynchronous while `session/event` is synchronous, so
  // it runs once here and the answer is cached. `undefined` means "not answered
  // yet", and a switch waits for it rather than recording a route the adapter
  // may reject at request time.
  let planRouteUsable: boolean | undefined
  const verify = async (): Promise<void> => {
    try {
      const models = await ctx.llm.listModels(resolved.planProvider)
      planRouteUsable = models.some(model => model.id === resolved.planModel)
      if (!planRouteUsable && resolved.verbose) {
        ctx.logger.warn('plan-model-sync: %s/%s is not in the provider catalog; '
          + 'plan mode will not switch models', resolved.planProvider, resolved.planModel)
      }
    } catch (error: unknown) {
      planRouteUsable = false
      ctx.logger.warn('plan-model-sync: could not read the provider catalog: %o', error)
    }
  }
  void verify()
  // `ctx.on` registers its own fiber effect, so wrapping it in `ctx.effect`
  // would nest a second registration and detach the subscription from this
  // plugin's lifetime.
  ctx.on('llm/adapters-updated', () => { void verify() })

  const observe = createPlanModelSync(resolved, {
    agentOf: id => ctx.agents.get(id),
    log: (level, message) => { ctx.logger[level](message) },
    planningRouteUsable: () => planRouteUsable,
  })
  ctx.on('session/event', observe)
}
