import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage, LlmError  } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function fail(message: string, code: string): () => never {
  return () => {
    throw new LlmError(message, code)
  }
}

describe('agent/request-error', () => {
  it('does not offer middleware failures to request recovery', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-narrow'), { provider: 'mock', model: 'mock' })
    let recoveries = 0
    ctx.on('agent/request', () => {
      throw new LlmError('middleware failed', 'MIDDLEWARE')
    })
    ctx.on('agent/request-error', async () => {
      recoveries += 1
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(recoveries).toBe(0)
    expect(adapter.requests).toHaveLength(0)
  })

  it('lets each failed request return a retry action before its turn closes', async () => {
    const adapter = new MockAdapter([
      fail('busy', 'RATE_LIMIT'),
      fail('unavailable', 'SERVICE_UNAVAILABLE'),
      textResponse('ok'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-retry'), { provider: 'mock', model: 'mock' })
    const seen: {
      turn: number
      step: number
      failure: LlmFailure
      retryPolicy: ResolvedRetryPolicy | undefined
    }[] = []
    const statuses: string[] = []
    ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent) statuses.push(status)
    })
    ctx.on('agent/request-error', async ({ agent: subject, turn, step, failure, retryPolicy }) => {
      expect(subject).toBe(agent)
      seen.push({ turn, step, failure, retryPolicy })
      return { kind: 'retry' }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(seen.map(item => ({
      turn: item.turn,
      step: item.step,
      code: item.failure.code,
    }))).toEqual([
      {
        turn: 1,
        step: 1,
        code: 'RATE_LIMIT',
      },
      {
        turn: 1,
        step: 1,
        code: 'SERVICE_UNAVAILABLE',
      },
    ])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(seen.map(item => item.retryPolicy)).toEqual([
      expect.objectContaining({ mode: 'normal' }),
      expect.objectContaining({ mode: 'normal' }),
    ])
    expect(statuses).toEqual(['running', 'idle'])
    expect(agent.session.snapshotEvents().flatMap(event =>
      event.type === 'request/header' ? [event.data.reason] : [])).toEqual(['initial'])
  })

  it('lets cancellation win over a retry action', async () => {
    const adapter = new MockAdapter([fail('busy', 'RATE_LIMIT'), textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-cancel'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request-error', async ({ agent: subject }) => {
      subject.cancel({ kind: 'user' })
      return { kind: 'retry' }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
  })

  it('does not retry when the recovery listener fails before returning its action', async () => {
    const adapter = new MockAdapter([fail('busy', 'RATE_LIMIT'), textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-recovery-failed'), {
      provider: 'mock',
      model: 'mock',
    })
    ctx.on('agent/request-error', async () => {
      throw new Error('recovery failed')
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error' } },
    })
  })

  it('retries a stop finish that leaves the final text on an open connector', async () => {
    const adapter = new MockAdapter([
      textResponse('结论：'),
      textResponse('结论：结果正常，复核通过。'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-incomplete-retry'), {
      provider: 'mock',
      model: 'mock',
    })
    const recoveries: string[] = []
    ctx.on('agent/request-error', async ({ failure }) => {
      recoveries.push(failure.code)
      return { kind: 'retry' }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(recoveries).toEqual(['INCOMPLETE_OUTPUT'])
    expect(adapter.requests).toHaveLength(2)
    const messages = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
    // The truncated first attempt must not be persisted into the session — only
    // the completed retry answer is appended.
    expect(messages).toHaveLength(1)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
  })

  it('ends the turn in error when request recovery refuses an incomplete output', async () => {
    const adapter = new MockAdapter([textResponse('看 /opt/dumate/skills/lark-cli 目录结构和 SKILL.md 位置：')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('incomplete-output-refused'), {
      provider: 'mock',
      model: 'mock',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    // No truncated assistant message may surface from a refused incomplete stop.
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(0)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: {
        reason: {
          kind: 'error',
          error: { code: 'INCOMPLETE_OUTPUT' },
        },
      },
    })
  })

  it('keeps a stop with a proper sentence ending as a completed turn', async () => {
    const adapter = new MockAdapter([textResponse('已复核完毕。')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('incomplete-output-false-positive'), {
      provider: 'mock',
      model: 'mock',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
  })

  it('treats a final reply that is only placeholder dots as incomplete output', async () => {
    const adapter = new MockAdapter([textResponse('...')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('incomplete-output-dots'), {
      provider: 'mock',
      model: 'mock',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    // No placeholder-only assistant message may surface.
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(0)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: {
        reason: {
          kind: 'error',
          error: { code: 'INCOMPLETE_OUTPUT' },
        },
      },
    })
  })

  it('retries a placeholder-only final reply when recovery returns a retry action', async () => {
    const adapter = new MockAdapter([
      textResponse('…'),
      textResponse('复核通过。'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('incomplete-output-dots-retry'), {
      provider: 'mock',
      model: 'mock',
    })
    const recoveries: string[] = []
    ctx.on('agent/request-error', async ({ failure }) => {
      recoveries.push(failure.code)
      return { kind: 'retry' }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(recoveries).toEqual(['INCOMPLETE_OUTPUT'])
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
  })

  it('keeps short but meaningful final replies completed', async () => {
    const adapter = new MockAdapter([textResponse('OK')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('incomplete-output-short-ok'), {
      provider: 'mock',
      model: 'mock',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
  })

  it('retries a stop that ends on an action-preview narration (announced, not executed)', async () => {
    const adapter = new MockAdapter([
      textResponse('发布调研+回滚报告（--parent 01a0470c-7ea3-792d-b089-54d6ed004f34）'),
      textResponse('调研+回滚报告已发布（--parent 01a0470c-7ea3-792d-b089-54d6ed004f34），见附件 reply.md。'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('incomplete-output-action-preview-retry'), {
      provider: 'mock',
      model: 'mock',
    })
    const recoveries: string[] = []
    ctx.on('agent/request-error', async ({ failure }) => {
      recoveries.push(failure.code)
      return { kind: 'retry' }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(recoveries).toEqual(['INCOMPLETE_OUTPUT'])
    expect(adapter.requests).toHaveLength(2)
    // The preview narration must not be persisted as an assistant message.
    expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(agent.session.events.find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
  })

  it('delivers an action-preview narration when recovery refuses (heuristic fails open)', async () => {
    const preview = '提交 回滚报告（--parent 01a0470c-7ea3-792d-b089-54d6ed004f34）'
    const adapter = new MockAdapter([textResponse(preview)])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('incomplete-output-action-preview-refused'), {
      provider: 'mock',
      model: 'mock',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    // QIA-426: the action-preview classification is a heuristic, so once
    // recovery is spent the text is delivered rather than lost. Losing a
    // legitimate short reply is the same user-visible damage as the leak.
    const messages = agent.session.events.filter(event => event.type === 'assistant/message')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      data: { message: { content: [{ type: 'text', text: preview }] } },
    })
    expect(agent.session.events.find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
  })

  it('still fails closed for structural truncation when recovery refuses', async () => {
    // Contrast with the action-preview case above: an open connector tail is a
    // structural fact, so a refused retry must not publish half a sentence.
    const adapter = new MockAdapter([textResponse('先看 worktree 状态，')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('incomplete-output-truncated-refused'), {
      provider: 'mock',
      model: 'mock',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(0)
    expect(agent.session.events.find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'INCOMPLETE_OUTPUT' } } },
    })
  })

  it('keeps an inline-code citation reply completed without any retry', async () => {
    // Acceptance-round shape: backtick citation, no sentence end, no
    // completion marker — a legitimate short reply, never a preview.
    const adapter = new MockAdapter([textResponse('运行 `pnpm test` 即可')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('incomplete-output-code-citation'), {
      provider: 'mock',
      model: 'mock',
    })
    let recoveries = 0
    ctx.on('agent/request-error', async () => {
      recoveries += 1
      return undefined
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(recoveries).toBe(0)
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(agent.session.events.find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
  })

  it('keeps a completed-action report with a cited option token as a valid final reply', async () => {
    const adapter = new MockAdapter([textResponse('已发布调研+回滚报告（--parent 01a05c0b-7fc3-792d-b089-54d6ed004f34）。')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('incomplete-output-action-preview-reported'), {
      provider: 'mock',
      model: 'mock',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
  })

  it('keeps a short instructional one-liner with a CLI flag completed', async () => {
    const adapter = new MockAdapter([textResponse('用 --force 覆盖即可。')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('incomplete-output-action-preview-instruction'), {
      provider: 'mock',
      model: 'mock',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
  })
})
