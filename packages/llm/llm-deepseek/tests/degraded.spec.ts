/** The composed Host reports a degraded Messages stream instead of failing the turn. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, LoggerLevel } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { assemble, end, options, sse, start } from './helpers.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function boot() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-messages-degraded-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, { baseURL: 'https://messages.example.test/root' })
  return ctx
}

describe('degraded Messages streams', () => {
  it('logs the dropped call and completes the turn with the surviving content', async () => {
    const ctx = await boot()
    const warnings: unknown[][] = []
    ctx.logger.exporter({ levels: { default: LoggerLevel.WARN }, export: (message) => { if (message.type === 'warn') warnings.push(message.args) } })
    const partial = '{"command": "ls'
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse([
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'planning' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'bash', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: partial } },
      { type: 'content_block_stop', index: 1 },
      ...end('tool_use'),
    ]))))

    const result = await assemble(ctx.llm.stream(options()))

    expect(result.message.content).toEqual([{ type: 'reasoning', text: 'planning' }])
    expect(result.assembler.finish).toEqual({ kind: 'stop' })
    expect(warnings).toEqual([[
      'llm-deepseek: route "deepseek-official/deepseek-v4-flash" settled a degraded Messages stream instead of failing the turn:'
        + ` tool-call-dropped (dropped tool call "bash" with unusable ${partial.length}-character arguments)`,
    ]])
  })

  it('completes a refused turn with the partial reply, a visible notice and a warning', async () => {
    const ctx = await boot()
    const warnings: unknown[][] = []
    ctx.logger.exporter({ levels: { default: LoggerLevel.WARN }, export: (message) => { if (message.type === 'warn') warnings.push(message.args) } })
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse([
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I can help with' } },
      ...end('refusal'),
    ]))))

    const result = await assemble(ctx.llm.stream(options()))

    expect(result.message.content).toEqual([{
      type: 'text',
      text: 'I can help with\n\n⚠ The model provider refused to continue this response (stop_reason "refusal"). Any reply above may be incomplete; rephrase the request or switch to another model.',
    }])
    expect(result.assembler.finish).toEqual({ kind: 'stop' })
    expect(warnings).toEqual([[
      'llm-deepseek: route "deepseek-official/deepseek-v4-flash" settled a degraded Messages stream instead of failing the turn:'
        + ' refusal (provider stop_reason "refusal" settled as stop with a visible notice)',
    ]])
  })
})
