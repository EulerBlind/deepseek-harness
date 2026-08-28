/**
 * Detect model output that ended under a `stop` finish yet looks unfinished:
 * a result that stops with no tool calls is supposed to deliver its final
 * reply, so a text block left hanging on an open connector — or containing
 * only placeholder punctuation such as `...` — is treated as an incomplete
 * completion rather than a finished answer. The same applies to an
 * **action-preview narration**: a short text that announces an action the
 * model claims it is about to take (e.g. `发布调研+回滚报告（--parent …）`) but
 * that never runs, because there are no tool calls left to execute it. The
 * model finished the *narration* instead of the action; persisting it as the
 * final reply would surface "I will reply" as the reply.
 *
 * The agent loop turns all of these into an `INCOMPLETE_OUTPUT` request
 * failure so the retry policy can re-run the step instead of letting a
 * half-written reply surface (e.g. to a comment thread). The two kinds differ
 * once retries are exhausted — structural truncation fails closed (turn
 * error), the action-preview heuristic fails open (deliver the text) — see
 * {@link UnfinishedOutputKind}.
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
  return UNFINISHED_TAIL.test(trimmed.charAt(trimmed.length - 1))
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
 * Action-preview narration cap: anything longer than this delivers real
 * content (a report, a table, a walkthrough) rather than a one-line intent,
 * so it must never be classified as a mere preview.
 */
const ACTION_PREVIEW_MAX_CHARS = 120

/**
 * Concrete command evidence in the **bare** text (inline code spans already
 * stripped by the caller): a `--flag value` invocation the narration claims it
 * is about to run. Inline code is deliberately NOT evidence — in agent prose a
 * code span is a *citation* (file name, branch name, parameter name, sample
 * command), e.g. 运行 `pnpm test` 即可 / 需要你补 `--parent` 参数, which are
 * legitimate short answers rather than announced actions (QIA-426 acceptance
 * round: an earlier backtick branch misjudged 10 of 17 real short replies).
 */
const COMMAND_FLAG = /(?:^|[\s（(])--[a-z][\w-]*(?:\s+|=)[\w./:@-]+/iu

/**
 * Inline code spans, stripped before the command test so a *cited* command can
 * never count as an *announced* one. Global: every span in the text is removed.
 */
const CODE_SPAN = /`[^`\n]*`/gu

/**
 * Completion markers that prove the announced action already happened: the
 * text then *reports* a finished state instead of *promising* one, and is a
 * legitimate final reply (e.g. `已发布…`，`回复已发布`，`评论与附件确认可见`，
 * `posted`、`done`、`finished`). Bare verbs like 发布/提交/推送/回复 are NOT
 * markers — in `发布…（--parent …）` they are the *unfulfilled* intention
 * itself, which is exactly the shape the action-preview rule must catch.
 */
const COMPLETION_MARKER = /已|完成|成功|确认|可见|入队|posted|done|finished|submitted|updated|ok\b/iu

/** A short final narration whose only "content" is an unfulfilled action preview. */
function isActionPreview(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (trimmed.length > ACTION_PREVIEW_MAX_CHARS) return false
  // A real answer closes its sentence (e.g. `用 --force 覆盖即可。`); an
  // unfulfilled narration ends right after its argument (`…（--parent …）`).
  if (/[。！？.!?]$/u.test(trimmed)) return false
  // The announcement must cite an executable flag OUTSIDE any code span…
  if (!COMMAND_FLAG.test(trimmed.replace(CODE_SPAN, ' '))) return false
  // …and must NOT be a report of an action that already happened.
  return !COMPLETION_MARKER.test(trimmed)
}

/**
 * Why a `stop` completion is not a deliverable final reply — and therefore how
 * the loop must dispose of it once retries are exhausted.
 *
 * - `truncated`: a **structural** fact. The text is physically cut off (open
 *   connector tail) or carries no content at all (placeholder dots).
 *   Misjudgment probability is negligible, so the loop keeps QIA-442's
 *   fail-closed handling: exhausted retries end the turn in error rather than
 *   publishing half a sentence.
 * - `action-preview`: a **semantic heuristic**. The text is syntactically
 *   whole but announces an action that never ran. Misjudgment probability is
 *   not negligible (a legitimate short reply can look like this), so the loop
 *   fails OPEN: exhausted retries deliver the original text. Fail-closed here
 *   would swallow a legitimate reply entirely — measured in the QIA-426
 *   acceptance round as 0 delivered messages, a turn error, and 6 model calls
 *   for one deterministic legitimate reply, i.e. a loss on par with the
 *   original leak plus the retry cost.
 */
export type UnfinishedOutputKind = 'truncated' | 'action-preview'

/**
 * Classify an assistant message that arrived under a `stop` finish with no
 * tool calls: whether it is an unfinished final reply, and if so of which
 * kind — the kind decides the retry-exhausted disposition, see
 * {@link UnfinishedOutputKind}.
 *
 * @param message - the assembled assistant message (text/tool-call blocks).
 * @returns the unfinished kind, or `undefined` for a deliverable final reply.
 */
export function classifyUnfinishedOutput(message: Message): UnfinishedOutputKind | undefined {
  const texts = message.content.filter((block): block is TextBlock => block.type === 'text')
  if (texts.length === 0) return undefined
  // A final text-only reply that consists solely of placeholders is a stall.
  if (texts.every(block => isPlaceholderOnly(block.text))) return 'truncated'
  if (texts.some(block => hasOpenTail(block.text))) return 'truncated'
  return texts.some(block => isActionPreview(block.text)) ? 'action-preview' : undefined
}
