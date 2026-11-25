/** Provider stop reasons: a refusal or an unknown value settles the turn with a visible notice instead of failing it. */
import { describe, expect, it } from 'vitest'
import { translate } from '../src/translate.ts'
import { readReplay } from '../src/replay.ts'
import type { StreamDegradation } from '../src/translate.ts'
import { assemble, end, events, MODEL, start, textEvents } from './helpers.ts'

const refusalNotice = '⚠ The model provider refused to continue this response (stop_reason "refusal"). Any reply above may be incomplete; rephrase the request or switch to another model.'

async function run(values: Record<string, unknown>[]) {
  const degraded: StreamDegradation[] = []
  const result = await assemble(translate(events(values), MODEL, degradation => degraded.push(degradation)))
  return { ...result, degraded }
}

describe('provider stop reasons', () => {
  it('keeps the streamed text and appends a refusal notice', async () => {
    const result = await run([...textEvents.slice(0, 4), ...end('refusal')])

    expect(result.message.content).toEqual([{ type: 'text', text: 'Hello 世界' }, { type: 'text', text: refusalNotice }])
    expect(result.assembler.finish).toEqual({ kind: 'stop' })
    expect(result.degraded).toEqual([{ kind: 'refusal', detail: 'provider stop_reason "refusal" settled as stop with a visible notice' }])
    expect(result.output.at(-2)).toMatchObject({ type: 'usage', usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } })
  })

  it('settles a refusal without any content as the notice instead of EMPTY_RESPONSE', async () => {
    const result = await run([start, ...end('refusal')])

    expect(result.message.content).toEqual([{ type: 'text', text: refusalNotice }])
    expect(result.assembler.finish).toEqual({ kind: 'stop' })
    expect(result.degraded.map(degradation => degradation.kind)).toEqual(['refusal'])
  })

  it('closes a block the refusal cut open and never dispatches an unfinished tool call', async () => {
    const result = await run([
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'plan' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a', name: 'bash', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
      ...end('refusal'),
    ])

    expect(result.message.content).toEqual([{ type: 'reasoning', text: 'plan' }, { type: 'text', text: refusalNotice }])
    expect(result.assembler.finish).toEqual({ kind: 'stop' })
    expect(result.degraded).toEqual([{ kind: 'refusal', detail: 'provider stop_reason "refusal" settled as stop with a visible notice; dropped unfinished tool call(s) "bash"' }])
  })

  it('places the notice after every block the assembler has seen', async () => {
    const result = await run([
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'partial' } },
      { type: 'content_block_stop', index: 1 },
      ...end('refusal'),
    ])

    expect(result.message.content).toEqual([{ type: 'text', text: 'partial' }, { type: 'text', text: refusalNotice }])
    expect(result.degraded.map(degradation => degradation.kind)).toEqual(['tool-call-dropped', 'refusal'])
  })

  it('appends the notice to the text block the refusal cut open', async () => {
    const result = await run([...textEvents.slice(0, 3), ...end('refusal')])

    expect(result.message.content).toEqual([{ type: 'text', text: `Hello 世界\n\n${refusalNotice}` }])
    expect(result.assembler.finish).toEqual({ kind: 'stop' })
    expect(result.assembler.replayState).toMatchObject({ blocks: [{ type: 'text' }] })
  })

  it('settles a refusal whose message_stop was lost', async () => {
    const result = await run([...textEvents.slice(0, 3), { type: 'message_delta', delta: { stop_reason: 'refusal' } }])

    expect(result.message.content).toEqual([{ type: 'text', text: `Hello 世界\n\n${refusalNotice}` }])
    expect(result.assembler.finish).toEqual({ kind: 'stop' })
  })

  it.each([['some_future_reason', 'some_future_reason'], [42, '42']])('settles unknown stop reason %s with a visible notice', async (raw, shown) => {
    const result = await run([...textEvents.slice(0, 4),
      { type: 'message_delta', delta: { stop_reason: raw }, usage: { output_tokens: 5 } }, { type: 'message_stop' }])

    expect(result.message.content).toEqual([
      { type: 'text', text: 'Hello 世界' },
      { type: 'text', text: `⚠ The model provider ended this response with an unrecognized stop reason "${shown}". Any reply above may be incomplete.` },
    ])
    expect(result.assembler.finish).toEqual({ kind: 'stop' })
    expect(result.degraded.map(degradation => degradation.kind)).toEqual(['unknown-stop-reason'])
  })

  it.each([
    ['pause_turn', { kind: 'stop' }],
    ['model_context_window_exceeded', { kind: 'max-tokens' }],
    ['end_turn', { kind: 'stop' }],
    ['stop_sequence', { kind: 'stop' }],
    ['max_tokens', { kind: 'max-tokens' }],
  ])('maps documented stop reason %s without a notice', async (raw, finish) => {
    const result = await run([...textEvents.slice(0, 4), ...end(raw)])

    expect(result.message.content).toEqual([{ type: 'text', text: 'Hello 世界' }])
    expect(result.assembler.finish).toEqual(finish)
    expect(result.degraded).toEqual([])
  })

  it('keeps the notice aligned with replay state so the next request can replay it', async () => {
    const result = await run([
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'plan', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      ...end('refusal'),
    ])

    expect(result.message.content).toEqual([{ type: 'reasoning', text: 'plan' }, { type: 'text', text: refusalNotice }])
    expect(result.assembler.replayState).toEqual({ response: { kind: 'deepseek-messages', version: 1, model: MODEL }, blocks: [{ type: 'reasoning', signature: 'sig' }, { type: 'text' }] })
    const problems: string[] = []
    expect(readReplay(result.message, MODEL, problem => problems.push(problem))).toEqual([{ type: 'reasoning', signature: 'sig' }, { type: 'text' }])
    expect(problems).toEqual([])
  })
})
