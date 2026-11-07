/** Plan-mode model switching behavior. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { createPlanModelSync, resolveConfig } from '../src/index.ts'

const PLANNING: ModelSelection = { provider: 'host', model: 'planning' }
const BUILD: ModelSelection = { provider: 'host', model: 'build' }
const CONFIG = resolveConfig({ planProvider: PLANNING.provider, planModel: PLANNING.model })

interface Bench {
  ctx: Context
  session: Session
  selections: ModelSelection[]
  logs: string[]
  /** Drive the observer for one logged event, as `Session.append` would. */
  emit(event: SessionEvent): void
  flip(active: boolean, turn: number): void
  /** Let queued microtasks (the deferred `select`) run. */
  flush(): Promise<void>
}

/** Register one Session over a real Session registry and build the observer. */
async function harness(options: {
  current?: ModelSelection
  /** `null` is a real state: the catalog has not answered yet. */
  usable?: boolean | null
  header?: { origin?: 'subagent'; parentSession?: SessionId }
  config?: ReturnType<typeof resolveConfig>
} = {}): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = options.header === undefined
    ? ctx.sessions.create()
    : ctx.sessions.create(undefined, { meta: options.header })
  const selections: ModelSelection[] = []
  const logs: string[] = []
  const agent = {
    id: session.id,
    model: {
      current: () => options.current,
      select: (selection: ModelSelection) => { selections.push({ ...selection }) },
    },
  } as unknown as Agent
  const observe = createPlanModelSync(options.config ?? CONFIG, {
    agentOf: id => (id === session.id ? agent : undefined),
    log: (_level, message) => { logs.push(message) },
    // `undefined` is a real state here (the catalog has not answered), so the
    // default must apply only when the option is absent. `null` spells that
    // state explicitly, since an optional property cannot hold `undefined`
    // under `exactOptionalPropertyTypes`.
    planningRouteUsable: () => ('usable' in options ? options.usable ?? undefined : true),
  })
  const emit = (event: SessionEvent): void => { observe(session, event) }
  return {
    ctx,
    session,
    selections,
    logs,
    emit,
    flip: (active, turn) => {
      // `plan-mode` commits each flip inside an open turn.
      session.append('turn/start', { turn })
      const logged = session.snapshotEvents().at(-1)
      void logged
      session.append('plan/mode', { active })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    },
    flush: () => new Promise<void>(resolve => { setImmediate(resolve) }),
  }
}

/** Detach the last logged event so the observer can be driven explicitly. */
function lastEvent(session: Session, type: string): SessionEvent {
  const found = [...session.snapshotEvents()].reverse().find(event => event.type === type)
  if (found === undefined) throw new Error(`no ${type} event logged`)
  return found
}

describe('resolveConfig', () => {
  it('requires both route fields', () => {
    expect(() => resolveConfig({ planModel: 'm' } as never)).toThrow(/planProvider/)
    expect(() => resolveConfig({ planProvider: 'p' } as never)).toThrow(/planModel/)
    expect(() => resolveConfig({ planProvider: ' ', planModel: 'm' })).toThrow(/planProvider/)
    expect(() => resolveConfig({ planProvider: 'p', planModel: '  ' })).toThrow(/planModel/)
  })

  it('defaults verbose to true and trims fields', () => {
    expect(resolveConfig({ planProvider: ' p ', planModel: ' m ' }))
      .toEqual({ planProvider: 'p', planModel: 'm', verbose: true })
  })

  it('keeps an explicit verbose false', () => {
    expect(resolveConfig({ planProvider: 'p', planModel: 'm', verbose: false }).verbose).toBe(false)
  })
})

describe('createPlanModelSync', () => {
  it('switches to the planning route when plan mode starts', async () => {
    const bench = await harness({ current: BUILD })
    bench.flip(true, 0)
    bench.emit(lastEvent(bench.session, 'plan/mode'))
    await bench.flush()
    expect(bench.selections).toEqual([PLANNING])
  })

  it('restores the route from before plan mode when it ends', async () => {
    const bench = await harness({ current: BUILD })
    bench.flip(true, 0)
    bench.emit(lastEvent(bench.session, 'plan/mode'))
    await bench.flush()
    bench.flip(false, 1)
    bench.emit(lastEvent(bench.session, 'plan/mode'))
    await bench.flush()
    expect(bench.selections).toEqual([PLANNING, BUILD])
  })

  it('does not overwrite the saved route on a repeated activation', async () => {
    const bench = await harness({ current: BUILD })
    bench.flip(true, 0)
    bench.emit(lastEvent(bench.session, 'plan/mode'))
    await bench.flush()
    bench.flip(true, 1)
    bench.emit(lastEvent(bench.session, 'plan/mode'))
    await bench.flush()
    bench.flip(false, 2)
    bench.emit(lastEvent(bench.session, 'plan/mode'))
    await bench.flush()
    expect(bench.selections).toEqual([PLANNING, BUILD])
  })

  it('leaves the model alone when the current route is already the planning route', async () => {
    const bench = await harness({ current: PLANNING })
    bench.flip(true, 0)
    bench.emit(lastEvent(bench.session, 'plan/mode'))
    await bench.flush()
    bench.flip(false, 1)
    bench.emit(lastEvent(bench.session, 'plan/mode'))
    await bench.flush()
    expect(bench.selections).toEqual([])
  })

  it('does nothing on deactivation without a saved route', async () => {
    const bench = await harness({ current: BUILD })
    bench.flip(false, 0)
    bench.emit(lastEvent(bench.session, 'plan/mode'))
    await bench.flush()
    expect(bench.selections).toEqual([])
  })

  it('never touches a subagent session', async () => {
    const bench = await harness({
      current: BUILD,
      // `SessionId` is a branded string; the observer only compares the header
      // origin, so a cast keeps the fixture readable.
      header: { origin: 'subagent', parentSession: 'parent' as SessionId },
    })
    bench.flip(true, 0)
    bench.emit(lastEvent(bench.session, 'plan/mode'))
    await bench.flush()
    expect(bench.selections).toEqual([])
  })

  it('keeps the current model when the planning route is unavailable', async () => {
    const bench = await harness({ current: BUILD, usable: false })
    bench.flip(true, 0)
    bench.emit(lastEvent(bench.session, 'plan/mode'))
    await bench.flush()
    expect(bench.selections).toEqual([])
    expect(bench.logs.join('\n')).toMatch(/unavailable/)
  })

  it('waits while the catalog has not answered', async () => {
    const bench = await harness({ current: BUILD, usable: null })
    bench.flip(true, 0)
    bench.emit(lastEvent(bench.session, 'plan/mode'))
    await bench.flush()
    expect(bench.selections).toEqual([])
  })

  it('leaves the model alone when no current route is known', async () => {
    const bench = await harness({})
    bench.flip(true, 0)
    bench.emit(lastEvent(bench.session, 'plan/mode'))
    await bench.flush()
    expect(bench.selections).toEqual([])
  })

  it('ignores unrelated session events', async () => {
    const bench = await harness({ current: BUILD })
    for (const event of bench.session.snapshotEvents()) bench.emit(event)
    await bench.flush()
    expect(bench.selections).toEqual([])
  })

  it('stays silent when verbose is false', async () => {
    const bench = await harness({
      current: BUILD,
      usable: false,
      config: resolveConfig({ planProvider: 'host', planModel: 'planning', verbose: false }),
    })
    bench.flip(true, 0)
    bench.emit(lastEvent(bench.session, 'plan/mode'))
    await bench.flush()
    // Diagnostic lines bypass `say` by design; only the switch narration must
    // respect `verbose`.
    const narration = bench.logs.filter(line => !line.includes('DIAG'))
    expect(narration).toEqual([])
  })
})

describe('apply wiring', () => {
  it('observes a live session append', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const selections: ModelSelection[] = []
    const agent = {
      id: session.id,
      model: {
        current: () => BUILD,
        select: (selection: ModelSelection) => { selections.push({ ...selection }) },
      },
    } as unknown as Agent
    const observe = createPlanModelSync(CONFIG, {
      agentOf: () => agent,
      log: () => {},
      planningRouteUsable: () => true,
    })
    ctx.effect(() => ctx.on('session/event', observe), 'test observer')
    session.append('turn/start', { turn: 0 })
    session.append('plan/mode', { active: true })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    // `select` is deferred past the in-flight append, so it lands on a later
    // microtask rather than inside `append` itself.
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(selections).toEqual([PLANNING])
  })
})
