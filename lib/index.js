// src/index.ts
/** Cordis plugin name used by loader diagnostics. */
const name = "plan-model-sync";
/** Host services required before the first `plan/mode` can be observed. */
const inject = [
	"agents",
	"llm",
	"sessions"
];
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
function resolveConfig(config) {
	return {
		planProvider: requiredField(config, "planProvider"),
		planModel: requiredField(config, "planModel"),
		verbose: config.verbose ?? true
	};
}
/** Read one required non-blank string field. */
function requiredField(config, key) {
	const value = config[key];
	if (typeof value !== "string" || value.trim() === "") throw new Error(`PlanModelSyncConfig needs a non-empty string \`${key}\``);
	return value.trim();
}
/** Compare two selections by route, ignoring reasoning effort. */
function sameRoute(left, right) {
	return left.provider === right.provider && left.model === right.model;
}
/**
* Build the `session/event` observer that mirrors plan mode onto the route.
*
* @param config - validated config.
* @param deps - Host lookups and logging.
* @returns the observer to register on `session/event`.
*/
function createPlanModelSync(config, deps) {
	const planningRoute = {
		provider: config.planProvider,
		model: config.planModel
	};
	/** Route in force when plan mode began, per top-level Session. */
	const beforePlan = /* @__PURE__ */ new WeakMap();
	const say = (level, message) => {
		if (config.verbose) deps.log(level, message);
	};
	/**
	* Record a selection once the in-flight append has settled.
	*
	* The append being published is the very `plan/mode` that triggered this
	* observer, so selecting inline would reenter the Session and throw. A
	* failure here is logged rather than propagated: it lands on a microtask,
	* outside any caller that could handle it, and an unhandled rejection would
	* be worse than one missed switch.
	*/
	const selectDeferred = (agent, selection) => {
		queueMicrotask(() => {
			try {
				agent.model.select(selection);
			} catch (error) {
				deps.log("warn", `plan-model-sync: could not record the model switch: ${String(error)}`);
			}
		});
	};
	return (session, event) => {
		if (event.type !== "plan/mode") return;
		if (session.header.origin === "subagent") return;
		const agent = deps.agentOf(session.id);
		if (agent === void 0) {
			say("info", "plan-model-sync: no live Agent for this Session; leaving the model alone");
			return;
		}
		if (event.data.active) {
			if (beforePlan.has(session)) {
				say("info", "plan-model-sync: already holding a route to restore; not overwriting");
				return;
			}
			const current = agent.model.current();
			if (current === void 0) {
				say("info", "plan-model-sync: no current route to restore; leaving the model alone");
				return;
			}
			if (sameRoute(current, planningRoute)) return;
			const usable = deps.planningRouteUsable();
			if (usable !== true) {
				if (usable === false) say("info", "plan-model-sync: planning route unavailable; plan mode keeps the current model");
				return;
			}
			beforePlan.set(session, current);
			selectDeferred(agent, planningRoute);
			say("info", `plan-model-sync: ${current.provider}/${current.model} → ${planningRoute.provider}/${planningRoute.model} for plan mode`);
			return;
		}
		const saved = beforePlan.get(session);
		if (saved === void 0) return;
		beforePlan.delete(session);
		selectDeferred(agent, saved);
		say("info", `plan-model-sync: plan mode ended; restored ${saved.provider}/${saved.model}`);
	};
}
/**
* Mirror plan mode onto the Session's model route.
*
* @param ctx - Host plugin context.
* @param config - planning route and logging verbosity.
* @returns nothing; the observation lives with the plugin fiber.
*/
function apply(ctx, config) {
	const resolved = resolveConfig(config);
	let planRouteUsable;
	const verify = async () => {
		try {
			planRouteUsable = (await ctx.llm.listModels(resolved.planProvider)).some((model) => model.id === resolved.planModel);
			if (!planRouteUsable && resolved.verbose) ctx.logger.warn("plan-model-sync: %s/%s is not in the provider catalog; plan mode will not switch models", resolved.planProvider, resolved.planModel);
		} catch (error) {
			planRouteUsable = false;
			ctx.logger.warn("plan-model-sync: could not read the provider catalog: %o", error);
		}
	};
	verify();
	ctx.on("llm/adapters-updated", () => {
		verify();
	});
	const observe = createPlanModelSync(resolved, {
		agentOf: (id) => ctx.agents.get(id),
		log: (level, message) => {
			ctx.logger[level](message);
		},
		planningRouteUsable: () => planRouteUsable
	});
	ctx.on("session/event", observe);
}
export { apply, createPlanModelSync, inject, name, resolveConfig };
