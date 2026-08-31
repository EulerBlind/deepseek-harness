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
 * half-written reply surface (e.g. to a comment thread). The kinds differ
 * once retries are exhausted — structural truncation fails closed (turn
 * error), the action-preview heuristic fails open (deliver the text) — see
 * {@link UnfinishedOutputKind}.
 *
 * A text-less final message is treated as unfinished when it carries content
 * that is invisible to the user (e.g. a reasoning-only stop: the model
 * thought but never produced a visible reply — QIA-426 v4). The classifier
 * requires **zero tool-call blocks** so a mid-flight tool step is never
 * misclassified, and it preserves the durable-call boundary for a genuinely
 * **empty** stop (`content: []`): adapters already classify a terminal stop
 * with no content as `EMPTY_RESPONSE`, and an empty `stop` reaching the loop
 * is a legitimate durable-call boundary for replay consumers.
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

/**
 * Sentence-final boundaries for the tail-clause split: CJK sentence ends
 * (。！？) and half-width !? are always boundaries; ASCII `.` is a boundary
 * ONLY when preceded by a non-alphanumeric char and followed by whitespace
 * or end — so `dir/file.ext`、`xx.yy` identifiers are never cut at their
 * dot (production N8 08-31 leaked for exactly this: the bare path
 * `sandbox/bridges/mcp.ts` was split at `.` and the tail clause started with
 * `ts`), while an English sentence-final period followed by a space IS a
 * boundary.
 */
const SENTENCE_BOUNDARY = /[。！？!?]|(?<![A-Za-z0-9])\.(?=\s|$)/u

/**
 * A completed ABSENCE report (QIA-426 v5 rework): the final clause carries
 * the check's RESULT — the queried thing is not there (查不到/日志里没有该
 * 记录/没有调用记录/去沙箱 pod 里看过，没有该文件). That is a deliverable
 * answer, unlike the unfulfilled promise shape, so the intent-lead rule must
 * not fire on clauses that open with 查/看/去 but end in a negative finding.
 * Deliberately matches NOUN-anchored absence only (记录/文件/日志/数据/
 * 调用/内容/痕迹…) — a bare 没有/无/未 alone (e.g. 有没有该文件) keeps the
 * promise reading and stays classified.
 */
const ABSENT_RESULT_MARKER = new RegExp(
  '(?:查不到|找不到|没找到|未找到|没查到|未查到|不存在|查无结果)'
  // （「有」字面领起的疑问句保持为意向，见注释）
  + '|(?<![\\u6709])(?:没有|无)(?:该|这个|任何|相关|一条|一行|一例)?'
  + '(?:记录|文件|日志|数据|内容|指令|调用|痕迹|迹象|线索|输出|结果|配置|信息|pod|条目)'
  + '|(?<![\\u6709])未(?:找到|发现|查到|看到|输出|出现|执行|设置)'
  + '|(?:未|不)见',
  'iu',
)

/**
 * A short final narration whose only "content" is an unfulfilled action preview.
 * Two shapes qualify:
 *
 * 1. a command preview citing a bare `--flag value` (QIA-426) — the text ends
 *    right after its argument (`发布调研+回滚报告（--parent …）`), no tool
 *    call ever runs it;
 * 2. a trailing intent clause (QIA-426 v5): the text ends WITHOUT any
 *    sentence-final punctuation and its final clause *leads* with an intent
 *    verb (先/再/接着/检查/查/下载/分析…), i.e. the model narrates "I am
 *    about to do X" and then stops instead of doing it. Production shapes
 *    (08-31 N7/N8 中断，均 ~180B 收尾): `N7 任务明确：…先下载 v5 契约并检查环境工`
 *    and `…查 mcp.ts — 看它怎么构造 header 转发请求`. The guard is NOT a
 *    generic "no terminal punctuation" test — a short statement that closes
 *    its clause with a completion particle (即可/就行/OK/done) or a backtick
 *    citation is a deliverable reply and must survive.
 */
function isActionPreview(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  // A real answer closes its sentence (e.g. `用 --force 覆盖即可。`); an
  // unfulfilled narration ends right after its connector (`…（--parent …）`)
  // or leaves its final clause without a sentence-final punctuation.
  if (/[。！？.!?]$/u.test(trimmed)) return false
  // …and must NOT be a report of an action that already happened.
  if (COMPLETION_MARKER.test(trimmed)) return false
  const stripped = trimmed.replace(CODE_SPAN, ' ')
  // Shape 1: announce a bare `--flag value` outside any code span — only
  // when the whole utterance stays short (a long text carrying a flag is a
  // real walkthrough, not a preview).
  if (trimmed.length <= ACTION_PREVIEW_MAX_CHARS && COMMAND_FLAG.test(stripped)) return true
  // Shape 2: the FINAL clause (text after the last sentence-final
  // punctuation) *starts* with an intent lead and has no completion marker —
  // the model wrote "let me go do X" and stopped instead of doing it. A
  // trailing backtick citation (`` `gh auth login` ``) is not an intent lead,
  // nor is a clause closed by a completion particle (即可/就行/没问题…) or a
  // citation noun (…的输出/…的结果 — "look at X's output" answers the user
  // instead of promising a self-action). Only the clause itself is
  // length-bounded, so a long report whose last clause is an unfulfilled
  // promise is still caught.
  const tailClause = stripped.split(SENTENCE_BOUNDARY).slice(-1).join('').trimStart()
  if (tailClause.length === 0 || tailClause.length > ACTION_PREVIEW_MAX_CHARS) return false
  if (/即可|就行|没问题|好了|行吧|OK|ok$|的输出$|的结果$/u.test(tailClause)) return false
  if (/^(?:没有|无|未见|未发现|未找到|查不到|找不到|不存在)/u.test(tailClause)) return false
  if (ABSENT_RESULT_MARKER.test(tailClause)) return false
  const intentLead = /^(?:先|接着|接下来|下一步|随后|再|继续|去|查(?!询)|下载|读取|获取|打开|跑|试|验证)/u
  return intentLead.test(tailClause)
}

/**
 * Why a `stop` completion is not a deliverable final reply — and therefore how
 * the loop must dispose of it once retries are exhausted.
 *
 * - `truncated`: a **structural** fact. The text is physically cut off (open
 *   connector tail), carries no content at all (placeholder dots), or was
 *   never produced in the first place (a reasoning-only stop — the model
 *   thought but its turn has no visible reply). Misjudgment probability is
 *   negligible, so the loop keeps QIA-442's fail-closed handling: exhausted
 *   retries end the turn in error rather than publishing half a sentence.
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
 * Three shapes are unfinished:
 * 1. a reasoning-only stop (text-less, non-empty, no tool calls) →
 *    `truncated`: the model thought but never produced a reply the user can
 *    read. Tool-call-only content is mid-flight and is NEVER classified here
 *    (the classifier itself enforces zero tool-call blocks — the caller's
 *    `stop && zero tool calls` guard is a second line).
 * 2. text that is only placeholder dots / an open connector tail →
 *    `truncated` (QIA-442).
 * 3. an action-preview diction — the model announces the action it claims it
 *    is about to take but no tool call ever runs it:
 *    - citing a bare `--flag value` (QIA-426), or
 *    - a trailing intent clause ending without sentence-final punctuation
 *      (QIA-426 v5, production N7/N8 中断 2026-08-31: `先下载 v5 契约并检查环境工`
 *      `/ 查 mcp.ts — 看它怎么构造 header 转发请求`).
 *    → `action-preview`, which fails OPEN on exhausted retries.
 *
 * A genuinely empty message (`content: []`) is NOT classified here: the
 * adapters turn a terminal stop with no content into `EMPTY_RESPONSE` before
 * it reaches the loop, and a truly empty stop that does reach it is a
 * legitimate durable-call boundary for replay consumers.
 *
 * @param message - the assembled assistant message (text/tool-call blocks).
 * @returns the unfinished kind, or `undefined` for a deliverable final reply.
 */
export function classifyUnfinishedOutput(message: Message): UnfinishedOutputKind | undefined {
  const texts = message.content.filter((block): block is TextBlock => block.type === 'text')
  if (texts.length === 0) {
    // Text-less but non-empty content: only a reasoning-only stop is
    // unfinished (the model thought but left no visible reply). Any content
    // carrying tool calls is a mid-flight tool step — never classified here
    // (preserves the tool-call-only contract at unfinished-output.spec.ts:125).
    // A genuinely empty message stays a durable replay boundary.
    if (message.content.length === 0) return undefined
    if (message.content.some(block => block.type === 'tool-call')) return undefined
    return 'truncated'
  }
  // A final text-only reply that consists solely of placeholders is a stall.
  if (texts.every(block => isPlaceholderOnly(block.text))) return 'truncated'
  if (texts.some(block => hasOpenTail(block.text))) return 'truncated'
  return texts.some(block => isActionPreview(block.text)) ? 'action-preview' : undefined
}
