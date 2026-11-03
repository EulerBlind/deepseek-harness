/** Translate Messages events while preserving block order and cumulative usage. */

import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { object, replayState } from './replay.ts'
import type { ReplayBlock } from './replay.ts'

/** One stream condition degraded instead of failing the turn; never carries model text. */
export interface StreamDegradation {
  /** What degraded: a dropped tool call, an ignored restarted message, or an early end. */
  kind: 'tool-call-dropped' | 'duplicate-message-start' | 'premature-end'
  /** Short diagnostic detail that is safe to log. */
  detail: string
}

interface Block {
  index: number
  content: Extract<ContentBlock, { type: ReplayBlock['type'] }>
  replay: ReplayBlock
  closed: boolean
  json: string
  /**
   * Chunks held back until the block can no longer be retracted. A Tool call is
   * buffered from its start to its close so unusable arguments never reach the
   * assembler, which can append or close a block but cannot remove one.
   */
  pending: StreamChunk[]
}

/** Decode a required string from provider JSON.
 * @param value - provider field.
 * @returns the validated string.
 */
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new LlmError('DeepSeek Messages expected a string field', 'MALFORMED_RESPONSE')
  return value
}

function malformed(detail: string): never {
  throw new LlmError(`DeepSeek Messages stream: ${detail}`, 'MALFORMED_RESPONSE')
}

function indexOf(event: Record<string, unknown>): number {
  if (!Number.isSafeInteger(event.index) || (event.index as number) < 0) return malformed('invalid block index')
  return event.index as number
}

/** Whether accumulated tool arguments stay executable by the shared parser and serializer.
 * @param raw - the arguments JSON a Tool call would carry; never empty, because the
 *   starting block always contributes at least the serialized initial input.
 * @returns false for non-object, malformed or truncated JSON.
 */
function executableArguments(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
  } catch (_unusableToolArguments) {
    return false
  }
}

/** The chunks a block emits when it opens; a Tool call holds them until its arguments are verified.
 * @param block - the block that was just created.
 * @returns the block-start chunk and any text already present in the starting block.
 */
function openingChunks(block: Block): StreamChunk[] {
  const chunks: StreamChunk[] = [{ type: 'block-start', index: block.index, blockType: block.content.type }]
  if (block.content.type === 'text' && block.content.text !== '') chunks.push({ type: 'text-delta', index: block.index, text: block.content.text })
  if (block.content.type === 'reasoning' && block.content.text !== '') chunks.push({ type: 'reasoning-delta', index: block.index, text: block.content.text })
  return chunks
}

function updateUsage(usage: TokenUsage, raw: unknown): void {
  const fields = object(raw)
  const keys = { input_tokens: 'inputTokens', output_tokens: 'outputTokens', cache_read_input_tokens: 'cacheReadTokens', cache_creation_input_tokens: 'cacheWriteTokens' } as const
  for (const [wire, local] of Object.entries(keys)) {
    const value = fields[wire]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || (value as number) < 0) return malformed(`invalid ${wire}`)
    usage[local] = value as number
  }
}

function startBlock(event: Record<string, unknown>, index: number): Block {
  const native = object(event.content_block)
  let content: Block['content']
  let replay: ReplayBlock
  switch (native.type) {
    case 'text': content = { type: 'text', text: string(native.text) }; replay = { type: 'text' }; break
    case 'thinking':
      content = { type: 'reasoning', text: string(native.thinking) }
      replay = { type: 'reasoning', ...native.signature === undefined ? {} : { signature: string(native.signature) } }
      break
    case 'tool_use':
      content = { type: 'tool-call', id: ToolCallId(string(native.id)), name: string(native.name), arguments: JSON.stringify(object(native.input)) }
      if (!content.id || !content.name) return malformed('empty tool identity')
      replay = { type: 'tool-call' }
      break
    default: throw new LlmError(`DeepSeek Messages does not support response block ${String(native.type)}`, 'UNSUPPORTED_CONTENT')
  }
  return { index, content, replay, closed: false, json: '', pending: [] }
}

function deltaChunk(block: Block, raw: unknown): StreamChunk | undefined {
  const delta = object(raw)
  const content = block.content
  if (delta.type === 'text_delta' && content.type === 'text') {
    const text = string(delta.text)
    content.text += text
    return { type: 'text-delta', index: block.index, text }
  }
  if (delta.type === 'thinking_delta' && content.type === 'reasoning') {
    const text = string(delta.thinking)
    content.text += text
    return { type: 'reasoning-delta', index: block.index, text }
  }
  if (delta.type === 'signature_delta' && content.type === 'reasoning') {
    block.replay.signature = (block.replay.signature ?? '') + string(delta.signature)
    return undefined
  }
  if (delta.type === 'input_json_delta' && content.type === 'tool-call') {
    const argumentsDelta = string(delta.partial_json)
    block.json += argumentsDelta
    return { type: 'tool-call-delta', index: block.index, id: content.id, argumentsDelta }
  }
  return malformed(`unsupported delta ${String(delta.type)} for ${content.type}`)
}

function stopReason(raw: unknown): FinishReason {
  switch (raw) {
    case 'end_turn': case 'stop_sequence': return { kind: 'stop' }
    case 'tool_use': return { kind: 'tool-calls' }
    case 'max_tokens': return { kind: 'max-tokens' }
    default: return malformed(`unsupported stop reason ${String(raw)}`)
  }
}

/** Settle a stream whose content is complete.
 * @param reason - provider stop reason, or the kind derived from the blocks kept.
 * @param blocks - blocks that already reached the stream; none can be retracted.
 * @param usage - cumulative token usage for the request.
 * @param model - requested model id stored in durable replay state.
 * @param degraded - true when a frame, a Tool call or the tail was already lost;
 *   an empty then settles as `stop` instead of failing the turn.
 * @returns the terminal usage and finish chunks.
 */
function* settlement(
  reason: FinishReason,
  blocks: Map<number, Block>,
  usage: TokenUsage,
  model: string,
  degraded = false,
): Generator<StreamChunk> {
  const toolCalls = [...blocks.values()].filter(block => block.content.type === 'tool-call')
  // A `tool-calls` settlement without a surviving call would hand the loop an
  // empty step; `stop` instead lets the unfinished-output guard re-request it.
  const settled: FinishReason = reason.kind === 'tool-calls' && toolCalls.length === 0 ? { kind: 'stop' } : reason
  // Losing every block to a degraded tail is the loss the sink already reported;
  // only a stream that never carried content is worth failing.
  if (blocks.size === 0 && settled.kind === 'stop' && !degraded) throw new LlmError('DeepSeek Messages returned no content', 'EMPTY_RESPONSE')
  usage.totalTokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  yield { type: 'usage', usage }
  yield { type: 'finish', reason: settled, replayState: replayState(model, [...blocks.values()].map(block => block.replay)) }
}

/** Translate decoded SSE data into the Harness stream protocol.
 *
 * A stream that loses a frame settles with what it has instead of voiding the
 * turn: a Tool call whose arguments cannot be executed is dropped (the loss is
 * one call), a restarted `message_start` keeps the first frame, and an early end
 * keeps every block that already completed — including a Tool call whose
 * arguments were complete when the stop frame was lost. A tail that lost its only
 * block settles as `stop` and is reported through onDegrade; only a stream that
 * never carried content fails.
 * @param events - framed, decoded provider events in arrival order.
 * @param model - requested model id stored in durable replay state.
 * @param onDegrade - optional diagnostic sink for degraded streams; receives no content.
 * @returns blocks, one final usage value, and exactly one terminal finish.
 */
export async function* translate(
  events: AsyncIterable<Record<string, unknown>>,
  model: string,
  onDegrade?: (degradation: StreamDegradation) => void,
): AsyncGenerator<StreamChunk> {
  const blocks = new Map<number, Block>()
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let started = false
  let reason: FinishReason | undefined
  let degraded = false
  const degrade = (kind: StreamDegradation['kind'], detail: string) => {
    degraded = true
    onDegrade?.({ kind, detail })
  }
  for await (const event of events) {
    if (event.type === 'message_start') {
      if (started) {
        // The provider restarted the envelope mid-stream; the first frame owns
        // the usage and the blocks already emitted stay authoritative.
        degrade('duplicate-message-start', 'kept the first message_start and ignored the restart')
        continue
      }
      updateUsage(usage, object(event.message).usage)
      started = true
      continue
    }
    if (!['content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'].includes(String(event.type))) {
      // Anthropic permits additional event types; content-bearing events remain validated below.
      continue
    }
    if (!started) return malformed('event precedes message_start')
    if (event.type === 'content_block_start') {
      const wireIndex = indexOf(event)
      if (blocks.has(wireIndex) || reason !== undefined) return malformed('block starts after settlement or repeats an index')
      const block = startBlock(event, blocks.size)
      blocks.set(wireIndex, block)
      const opening = openingChunks(block)
      if (block.content.type === 'tool-call') {
        // A call whose arguments fail validation must never reach the assembler
        // (it can append blocks but not retract one), so its opening chunks wait.
        block.pending.push(...opening)
        continue
      }
      yield* opening
    } else if (event.type === 'content_block_delta' || event.type === 'content_block_stop') {
      const wireIndex = indexOf(event)
      const block = blocks.get(wireIndex)
      if (block === undefined || block.closed) return malformed('delta/stop without an open block')
      if (event.type === 'content_block_delta') {
        const chunk = deltaChunk(block, event.delta)
        if (chunk === undefined) continue
        if (block.content.type === 'tool-call') block.pending.push(chunk)
        else yield chunk
      } else {
        block.closed = true
        if (block.content.type === 'tool-call' && block.json.length > 0) block.content.arguments = block.json
        if (block.content.type === 'tool-call' && !executableArguments(block.content.arguments)) {
          // Truncated or non-object arguments cannot be dispatched or replayed;
          // dropping the call costs this step one call, not the whole turn.
          blocks.delete(wireIndex)
          degrade('tool-call-dropped', `dropped tool call "${block.content.name}" with unusable ${block.content.arguments.length}-character arguments`)
          continue
        }
        yield* block.pending
        yield { type: 'block-end', index: block.index, block: { ...block.content } }
      }
    } else if (event.type === 'message_delta') {
      const delta = object(event.delta)
      if (delta.stop_reason != null) reason = stopReason(delta.stop_reason)
      if (event.usage !== undefined) updateUsage(usage, event.usage)
    } else {
      if (reason === undefined || [...blocks.values()].some(block => !block.closed)) return malformed('message_stop without settled blocks and stop reason')
      yield* settlement(reason, blocks, usage, model, degraded)
      return
    }
  }
  // The provider closed the stream without `message_stop`. A partially streamed
  // reply must not surface as the answer, so visible text keeps the fail-closed
  // behavior; a Tool call is kept when its arguments completed and dropped with a
  // degradation when they were cut, so a tail never voids the whole turn.
  if ([...blocks.values()].some(block => !block.closed && block.content.type === 'text')) {
    throw new LlmError('DeepSeek Messages stream ended before message_stop', 'STREAM_CLOSED')
  }
  const cut: string[] = []
  for (const [wireIndex, block] of blocks) {
    if (block.closed || block.content.type !== 'tool-call') continue
    if (block.json.length > 0 && executableArguments(block.json)) {
      // The arguments arrived complete; only the close the provider never sent is
      // missing, so the call is still dispatchable.
      block.content.arguments = block.json
      block.closed = true
      yield* block.pending
      yield { type: 'block-end', index: block.index, block: { ...block.content } }
      continue
    }
    blocks.delete(wireIndex)
    cut.push(block.content.name)
  }
  if (cut.length > 0) degrade('premature-end', `dropped tool call(s) ${cut.map(name => `"${name}"`).join(', ')} the provider cut mid-arguments`)
  if (blocks.size === 0 && !degraded) throw new LlmError('DeepSeek Messages stream ended before message_stop', 'STREAM_CLOSED')
  if (blocks.size > 0 && cut.length === 0) degrade('premature-end', `settled ${blocks.size} block(s) after the provider closed the stream early`)
  const settled = reason ?? ([...blocks.values()].some(block => block.content.type === 'tool-call') ? { kind: 'tool-calls' as const } : { kind: 'stop' as const })
  yield* settlement(settled, blocks, usage, model, degraded)
}
