import { describe, expect, it } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { classifyUnfinishedOutput } from '../src/unfinished-output.ts'

function finalText(text: string) {
  return createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'mock', model: 'mock' } })
}

/**
 * QIA-426 action-preview narration guard. A stop with zero tool calls whose
 * final text only *announces* an action (short, citing a bare `--flag value`
 * outside any code span, no completion marker) is classified `action-preview`;
 * structurally broken output stays `truncated`; everything else is a
 * deliverable reply (`undefined`).
 *
 * The kind matters beyond detection: `truncated` fails closed on exhausted
 * retries while `action-preview` fails open — the end-to-end dispositions live
 * in `request-error.spec.ts`.
 */
describe('classifyUnfinishedOutput · action-preview narration (QIA-426)', () => {
  it('detects the production leak: announce + bare --parent id, no completion marker', () => {
    // Real 08-28 leak: 78 bytes, published as the comment body.
    expect(classifyUnfinishedOutput(finalText('发布调研+回滚报告（--parent 01a0470c-7ea3-792d-b089-54d6ed004f34）')))
      .toBe('action-preview')
  })

  it('detects other action-preview shapes', () => {
    expect(classifyUnfinishedOutput(finalText('提交 回滚报告（--parent 01a0470c-7ea3-792d-b089-54d6ed004f34）')))
      .toBe('action-preview')
    expect(classifyUnfinishedOutput(finalText('回滚报告发布（--parent 01a0470c-7ea3-792d-b089-54d6ed004f34）')))
      .toBe('action-preview')
    expect(classifyUnfinishedOutput(finalText('执行 multica issue comment add ... --parent 01a0470c')))
      .toBe('action-preview')
  })

  it('records the residual over-match a text heuristic cannot avoid', () => {
    // Acceptance gap 3: a legitimate suggestion carrying a bare `--flag value`
    // with no sentence end and no completion marker is indistinguishable from
    // an announcement in plain text. It is classified action-preview on
    // purpose — and the action-preview kind fails OPEN, so the cost is bounded
    // to one retry budget and the reply is still delivered (see the llm-retry
    // end-to-end case). Documented, not silently accepted.
    expect(classifyUnfinishedOutput(finalText('建议加 --parent 01a0470c'))).toBe('action-preview')
    expect(classifyUnfinishedOutput(finalText('重跑时带 --filter agent-loop'))).toBe('action-preview')
  })

  it('classifies structural breakage as truncated, not action-preview', () => {
    expect(classifyUnfinishedOutput(finalText('...'))).toBe('truncated')
    expect(classifyUnfinishedOutput(finalText('⋯'))).toBe('truncated')
    expect(classifyUnfinishedOutput(finalText('结论：'))).toBe('truncated')
    expect(classifyUnfinishedOutput(finalText('看 /opt/dumate/skills/lark-cli 目录结构和 SKILL.md 位置：')))
      .toBe('truncated')
  })

  /**
   * Acceptance-round corpus (QIA-426 R1): an inline code span is a CITATION —
   * file name, branch name, parameter name, sample command — not an announced
   * action. Each of these carries a backtick span, no sentence-final
   * punctuation and no completion marker: the exact cell the first
   * implementation left uncovered, where its backtick branch misjudged 10 of
   * 17 legitimate short replies.
   */
  it('false-positive guard: backtick + no sentence end + no completion marker stays deliverable', () => {
    const citations = [
      '运行 `pnpm test` 即可',
      '需要你补 `--parent` 参数',
      '没有权限，需要 `gh auth login`',
      '两条链都在 `fix/qia426-action-preview`',
      '看 `git log --oneline -1` 的输出',
      '在 `packages/core/agent-loop` 下',
      '`isActionPreview` 只在 stop + 零 tool call 时生效',
      '用 `--force` 覆盖',
      '改 `COMMAND_EVIDENCE` 就行',
      '推荐 `pnpm exec vitest run` 而不是全量 `pnpm test`',
    ]
    for (const text of citations) {
      expect(classifyUnfinishedOutput(finalText(text)), text).toBeUndefined()
    }
  })

  it('false-positive guard: already-completed reports stay deliverable even with a flag token', () => {
    expect(classifyUnfinishedOutput(finalText('已发布调研+回滚报告（--parent 01a0470c-7ea3-792d-b089-54d6ed004f34）。')))
      .toBeUndefined()
    expect(classifyUnfinishedOutput(finalText('回复已发布（含 implementation-node10.md 附件，BA mention 已入队）。')))
      .toBeUndefined()
    expect(classifyUnfinishedOutput(finalText('评论与附件确认可见。任务完成。'))).toBeUndefined()
    expect(classifyUnfinishedOutput(finalText('回滚已执行。'))).toBeUndefined()
    expect(classifyUnfinishedOutput(finalText('已处理。'))).toBeUndefined()
  })

  it('false-positive guard: short meaningful replies and instructions stay deliverable', () => {
    expect(classifyUnfinishedOutput(finalText('OK'))).toBeUndefined()
    expect(classifyUnfinishedOutput(finalText('用 --force 覆盖即可。'))).toBeUndefined()
    expect(classifyUnfinishedOutput(finalText('如需重试，执行 multica issue comment add 9bd0... --parent 01a0470c 即可。')))
      .toBeUndefined()
    expect(classifyUnfinishedOutput(finalText('根因已复核，证据链充分。拍板修复方向并派发。'))).toBeUndefined()
  })

  it('false-positive guard: long real content is never an action preview', () => {
    const longInstruction = '两个新测试需要修正：count 输出对应 count 帧（名字映射错位），error 场景需要正确执行生成器才抛异常。修正这两个测试。'
    expect(classifyUnfinishedOutput(finalText(longInstruction))).toBeUndefined()
    // Longer than the ACTION_PREVIEW_MAX_CHARS cap: real content, not a preview.
    const longNarration = '发布调研+回滚报告（--parent 01a0470c-7ea3-792d-b089-54d6ed004f34），并将完整交付物料、回滚范围、验证证据与后续建议整理进实施说明文档以便审阅；同时确认该修复不影响既有 completed 输出的发布通路。'
    expect(longNarration.length).toBeGreaterThan(120)
    expect(classifyUnfinishedOutput(finalText(longNarration))).toBeUndefined()
  })

  it('keeps mixed whitespace/empty + meaningful blocks deliverable', () => {
    // Empty/whitespace-only blocks are placeholders that need at least one
    // real block to be the reply; with a proper sentence the turn is complete.
    expect(classifyUnfinishedOutput(
      createAssistantMessage({
        content: [{ type: 'text', text: '' }, { type: 'text', text: '结论。' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    )).toBeUndefined()
    expect(classifyUnfinishedOutput(
      createAssistantMessage({
        content: [{ type: 'text', text: ' ' }, { type: 'text', text: '正常回复。' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    )).toBeUndefined()
  })

  it('keeps a text-less tool-call-only message out of the unfinished judgment', () => {
    // The loop never calls this with tool calls present, but the classifier
    // must not misclassify a text-less message (empty texts array).
    expect(classifyUnfinishedOutput(
      createAssistantMessage({
        content: [{ type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{}' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    )).toBeUndefined()
  })

  // ── QIA-426 v4: reasoning-only / empty stop shapes ────────────────────────

  it('detects a reasoning-only stop as truncated (QIA-426 v4)', () => {
    // Production shape: `stop` with only a reasoning block and no visible
    // text. The model thought but never produced a reply the user can read.
    expect(classifyUnfinishedOutput(
      createAssistantMessage({
        content: [{ type: 'reasoning', text: 'Let me think about the pod. The sandbox was recreated.' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    )).toBe('truncated')
  })

  it('keeps a reasoning + text stop deliverable (regression guard)', () => {
    // A normal thinking-chain answer ends with visible text — never misjudged.
    expect(classifyUnfinishedOutput(
      createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'Let me check the pod first.' },
          { type: 'text', text: '结论：根因已复核，证据链充分。' },
        ],
        source: { provider: 'mock', model: 'mock' },
      }),
    )).toBeUndefined()
  })

  it('keeps a text-less reasoning + tool-call message out of the judgment', () => {
    // Reasoning alongside a tool call is mid-flight — the classifier must not
    // treat it as an unfinished final reply.
    expect(classifyUnfinishedOutput(
      createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'I need to run a command.' },
          { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{}' },
        ],
        source: { provider: 'mock', model: 'mock' },
      }),
    )).toBeUndefined()
  })

  it('keeps a genuinely empty stop as a durable boundary, not unfinished', () => {
    // Adapters convert a terminal stop with no content to EMPTY_RESPONSE
    // before it reaches the loop; a truly empty stop that does reach it is a
    // legitimate durable-call boundary for replay consumers.
    expect(classifyUnfinishedOutput(
      createAssistantMessage({ content: [], source: { provider: 'mock', model: 'mock' } }),
    )).toBeUndefined()
  })

  // ── QIA-426 v5: trailing intent clause (2026-08-31 N7/N8 中断) ─────────────

  it('detects N7: final clause leads with intent 先下载… and cut mid-word', () => {
    // Production 08-31 14:54 turn 7 final text (task 01a05698, 180B): the model
    // wrote "N7 任务明确：…先下载 v5 契约并检查环境工" — a narration of the
    // next action that never ran, no terminal punctuation, stop finish.
    const text = 'N7 任务明确：①CR 归属判定（查服务器镜像构建来源分支）②4 项配置核查（K104 vs K238）③连接器健康盘点。先下载 v5 契约并检查环境工'
    expect(classifyUnfinishedOutput(finalText(text))).toBe('action-preview')
  })

  it('detects N8: final clause leads with 查 and stops before doing it', () => {
    // Production 08-31 15:56 turn 8 step 36 (task 01a056cf, 179B): the model
    // said "查 mcp.ts — 看它怎么构造 header 转发请求" and stopped without a
    // read tool call — the action the narration announced never ran.
    const text = 'qianfan-desk 有完整 MCP 实现。查 `server/src/server/routes/mcp.ts` 和 `sandbox/bridges/mcp.ts`——这是引擎侧 MCP 调用入口，看它怎么构造 header 转发请求'
    expect(classifyUnfinishedOutput(finalText(text))).toBe('action-preview')
  })

  it('false-positive guard: sentences closed by a completion particle stay deliverable', () => {
    // Same尾 shape but the clause closes itself — the reply is a deliverable
    // even without 。: completion particles (即可/就行/没问题/可以…) and
    // completion markers (已/完成/成功) declare the state instead of
    // promising one.
    expect(classifyUnfinishedOutput(finalText('先看一下再给你结论即可'))).toBeUndefined()
    expect(classifyUnfinishedOutput(finalText('先跑 `pnpm test` 就行'))).toBeUndefined()
    expect(classifyUnfinishedOutput(finalText('接下来执行 `pnpm build` 即可'))).toBeUndefined()
    expect(classifyUnfinishedOutput(finalText('先查 `git log --oneline -1` 的输出'))).toBeUndefined()
    expect(classifyUnfinishedOutput(finalText('下一步已完成，等 CI 结果'))).toBeUndefined()
  })

  it('false-positive guard: statements starting with 检查/确认/分析 but reporting a state stay deliverable', () => {
    // 检查/确认/分析 can also open a *statement* about a fact, not an
    // unfulfilled promise — the completion mark or a closed sentence is the
    // difference.
    expect(classifyUnfinishedOutput(finalText('确认无误。'))).toBeUndefined()
    expect(classifyUnfinishedOutput(finalText('检查发现无异常'))).toBeUndefined()
    expect(classifyUnfinishedOutput(finalText('分析结果已写入 report.md'))).toBeUndefined()
    expect(classifyUnfinishedOutput(finalText('确认会有影响，需要知会用户'))).toBeUndefined()
  })

  it('length guard: an intent-lead final clause longer than the cap is real content', () => {
    // Only the FINAL CLAUSE is length-bounded — a clause > 120 chars leading
    // with 先 is a report whose sentence simply has no trailing punctuation,
    // not a preview.
    const clause = '下载契约附件并检查环境工作目录中的相关配置与连接器状态信息后给出结论与后续建议安排'
    const text = '报告很长的前置说明。' + '先' + clause.repeat(3)
    const tail = text.split(/[。！？.!?]/u).pop() ?? ''
    expect(tail.length).toBeGreaterThan(120)
    expect(classifyUnfinishedOutput(finalText(text))).toBeUndefined()
  })

  it('tail extraction empties: a text ending in closing punctuation is not an intent lead', () => {
    // Sentence-final punctuation bails earlier; make sure the interplay stays
    // deliverable for a text that contains 、 and ： but closes normally.
    expect(classifyUnfinishedOutput(finalText('先查看：内容不再有异常。'))).toBeUndefined()
  })
})
