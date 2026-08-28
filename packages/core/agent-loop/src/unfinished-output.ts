/**
 * Detect model output that ended under a `stop` finish yet looks interrupted:
 * a model that stops with no tool calls is supposed to deliver its final
 * reply, so a text block left hanging on an open connector — or containing
 * only placeholder punctuation such as `...` — is treated as an incomplete
 * completion rather than a finished answer. The agent loop turns these into
 * an `INCOMPLETE_OUTPUT` request failure so the retry policy can re-run the
 * step instead of letting a half-written reply surface (e.g. to a comment
 * thread).
 *
 * A strictly empty response is NOT treated as incomplete here: adapters
 * already classify a terminal stop with no content as `EMPTY_RESPONSE`, and
 * an empty `stop` reaching the loop is a legitimate durable-call boundary for
 * replay consumers.
 *
 * @module dsh-agent-loop/unfinished-output
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/**
 * Trailing punctuation that marks an obviously unfinished sentence.
 * - 中文：冒号/逗号/顿号/分号/省略号
 * - 英文：冒号/分号/逗号/省略号
 *
 * Deliberately excludes `。.!?`（句末）、`）]}`（闭合）以及路径/代码尾的
 * `/`、`-`、`+` —— 那些是合法完整结尾。
 */
const UNFINISHED_TAIL = /[：，、；…:;,]$/u

/** A final text block ends with an open connector. */
function hasOpenTail(text: string): boolean {
  const trimmed = text.trimEnd()
  if (trimmed.length === 0) return false
  return UNFINISHED_TAIL.test(trimmed[trimmed.length - 1] ?? '')
}

/**
 * Placeholder-only content regex: after removing whitespace, the block is
 * nothing but ellipsis-ish dots (`...`, `..`, `…`, `⋯`) with no real words.
 * A final reply like this is not deliverable — the model visibly stalled
 * instead of answering (seen in production as a final `...` comment).
 */
const PLACEHOLDER_ONLY = /^[.…⋯]+$/u

/**
 * A text block carrying no actual content: empty or only dots/ellipsis.
 * An assistant message whose every text block looks like this cannot serve
 * as the final reply.
 */
function isPlaceholderOnly(text: string): boolean {
  const compact = text.replace(/\s+/g, '')
  return compact.length === 0 || PLACEHOLDER_ONLY.test(compact)
}

/** A text content block. */
type TextBlock = Extract<ContentBlock, { type: 'text' }>

/**
 * Determine whether an assistant message is an interrupted final text reply.
 *
 * @param message - the assembled assistant message (text/tool-call blocks).
 * @returns true when the `stop` completion should be treated as `INCOMPLETE_OUTPUT`.
 */
export function isUnfinishedOutput(message: Message): boolean {
  const texts = message.content.filter((block): block is TextBlock => block.type === 'text')
  if (texts.length === 0) return false
  // A final text-only reply that consists solely of placeholders is a stall.
  const allPlaceholder = texts.every(block => isPlaceholderOnly(block.text))
  if (allPlaceholder) return true
  return texts.some(block => hasOpenTail(block.text))
}
