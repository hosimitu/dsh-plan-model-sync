import { Context } from "@deepseek-ai/cordis";
import { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionEvent } from "@deepseek-ai/dsh-session";
/** Cordis plugin name used by loader diagnostics. */
declare const name = "plan-model-sync";
/** Host services required before the first `plan/mode` can be observed. */
declare const inject: string[];
/** Deployment configuration: the planning route, and logging verbosity. */
interface Config {
  /** Provider route to use while plan mode is active. */
  planProvider: string;
  /** Model id on {@link planProvider} to use while plan mode is active. */
  planModel: string;
  /** Log why a switch was skipped. Defaults to true. */
  verbose?: boolean;
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
declare function resolveConfig(config: Config): Required<Config>;
/** What the observer needs from the Host, passed explicitly so it stays testable. */
interface SyncDeps {
  /** Look up the live Agent for one Session id. */
  agentOf(id: Session['id']): Agent | undefined;
  /** Log a skipped or completed switch. */
  log(level: 'info' | 'warn', message: string): void;
  /**
   * Whether the planning route may be selected. `undefined` means the catalog
   * has not answered yet, so no switch is attempted.
   */
  planningRouteUsable(): boolean | undefined;
}
/**
 * Build the `session/event` observer that mirrors plan mode onto the route.
 *
 * @param config - validated config.
 * @param deps - Host lookups and logging.
 * @returns the observer to register on `session/event`.
 */
declare function createPlanModelSync(config: Required<Config>, deps: SyncDeps): (session: Session, event: SessionEvent) => void;
/**
 * Mirror plan mode onto the Session's model route.
 *
 * @param ctx - Host plugin context.
 * @param config - planning route and logging verbosity.
 * @returns nothing; the observation lives with the plugin fiber.
 */
declare function apply(ctx: Context, config: Config): void;
export { Config, SyncDeps, apply, createPlanModelSync, inject, name, resolveConfig };