/**
 * agents-block.mjs — Codex `AGENTS.md` 里「本插件规则块」的解析与更新。
 * English: locates and updates this plugin's marked AGENTS.md guidance blocks.
 * Stable markers recognize older versioned blocks. Damaged markers do not define
 * a safe boundary; callers must reject changes rather than consume user text.
 *
 * 为什么单独成模块：规则块跨版本升级时最容易出错的是标记匹配。
 * 旧版标记带版本号（`begin v2.2.0`），新版只用稳定插件标识（`begin`）；
 * 用户文件里还可能有多个历史副本、无关文字，或损毁的不成对标记。
 * 这里的策略：识别完整规则块并替换；标记损毁时保守拒绝，不猜测边界。
 *
 * 只接触标记内（以及紧邻的少量空行）的内容；标记外的用户文字逐字保留，
 * 不做全文重排，也不动行尾空格（markdown 里两个空格是换行）。
 */

export const START_MARKER = '<!-- dsh-multi-agent:begin -->'
export const END_MARKER = '<!-- dsh-multi-agent:end -->'

/** 稳定标识 + 兼容历史版本号标记（v2.2.0 / v2.2.2 等）。 */
const BEGIN_PATTERN = /^[ \t]*<!--\s*dsh-multi-agent:begin(?:\s+v?[\w.\-]+)?\s*-->[ \t]*$/
const END_PATTERN = /^[ \t]*<!--\s*dsh-multi-agent:end\s*-->[ \t]*$/

export function isBeginMarker(line) {
  return BEGIN_PATTERN.test(String(line))
}

export function isEndMarker(line) {
  return END_PATTERN.test(String(line))
}

/**
 * 找出所有归属规则块的区间（按行，end 不含）。
 * - 正常块：begin … end
 * - 不成对：只有 begin（区间延续到下一个 begin 或文件末尾），或只有 end（stray）
 *   都标记 unbalanced，调用方可以在报告里提示。
 */
export function findPluginBlocks(text) {
  const lines = String(text).split('\n')
  const blocks = []
  let open
  for (let i = 0; i < lines.length; i += 1) {
    if (isBeginMarker(lines[i])) {
      if (open !== undefined) blocks.push({ start: open, end: i, unbalanced: true })
      open = i
    } else if (isEndMarker(lines[i])) {
      if (open === undefined) blocks.push({ start: i, end: i + 1, unbalanced: true, stray: true })
      else {
        blocks.push({ start: open, end: i + 1, unbalanced: false })
        open = undefined
      }
    }
  }
  if (open !== undefined) blocks.push({ start: open, end: lines.length, unbalanced: true })
  return blocks
}

/**
 * 结构分析：把「正常配对块」与「损毁标记」分开。
 *
 * 损毁（不成对）的标记无法可靠判断插件内容到哪里结束；此时调用方必须保守拒绝
 * 写入/删除，而不是按「最大范围」清理，否则会把后面的用户文字一起吞掉。
 */
export function analyzePluginBlocks(text) {
  const blocks = findPluginBlocks(text)
  return {
    blocks,
    complete: blocks.filter((item) => !item.unbalanced),
    damaged: blocks.filter((item) => item.unbalanced),
    damagedCount: blocks.filter((item) => item.unbalanced).length,
    unbalanced: blocks.some((item) => item.unbalanced),
  }
}

/** 取一个块区间（begin…end 行）的原始文本，用于与安装记录里的哈希比对。 */
export function blockText(text, block) {
  return String(text).split('\n').slice(block.start, block.end).join('\n')
}

/** 把 [start, end) 替换成 insert，并把接缝处的空行收敛成「最多一个」。 */
function spliceWithSeam(lines, start, end, insert) {
  const result = [...lines.slice(0, start), ...insert, ...lines.slice(end)]
  const seamStart = start
  const seamEnd = start + insert.length

  let head = seamStart
  while (head > 0 && result[head - 1] === '') head -= 1
  let tail = seamEnd
  while (tail < result.length && result[tail] === '') tail += 1

  const before = result.slice(0, head)
  const block = result.slice(seamStart, seamEnd)
  const after = result.slice(tail)
  const out = [...before]
  if (block.length) {
    if (out.length) out.push('')
    out.push(...block)
    if (after.length) out.push('')
  } else if (out.length && after.length) {
    out.push('')
  }
  out.push(...after)
  return out
}

function finish(lines) {
  const out = [...lines]
  while (out.length && out[out.length - 1] === '') out.pop()
  return out.length ? `${out.join('\n')}\n` : ''
}

/**
 * 用新规则块替换文件里的所有历史副本（保留第一处的位置）。
 * `removed` 是识别到的旧块数量，`unbalanced` 表示遇到过损毁标记。
 */
export function upsertPluginBlock(text, block) {
  const source = String(text ?? '')
  const blocks = findPluginBlocks(source)
  const blockLines = String(block).replace(/^\s+/, '').replace(/\s+$/, '').split('\n')

  if (!blocks.length) {
    const lines = source.split('\n')
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    const out = lines.length ? [...lines, '', ...blockLines] : [...blockLines]
    return { text: finish(out), removed: 0, unbalanced: false }
  }

  const anchorIndex = blocks.findIndex((item) => !item.stray)
  let lines = source.split('\n')
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const region = blocks[i]
    const insert = i === anchorIndex ? blockLines : []
    lines = spliceWithSeam(lines, region.start, region.end, insert)
  }
  return {
    text: finish(lines),
    removed: blocks.length,
    unbalanced: blocks.some((item) => item.unbalanced),
  }
}

/** 移除所有归属规则块（卸载用），返回清理后的文本与被删除的块数。 */
export function stripPluginBlocks(text) {
  const source = String(text ?? '')
  const blocks = findPluginBlocks(source)
  if (!blocks.length) return { text: source, removed: 0, unbalanced: false }

  let lines = source.split('\n')
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    lines = spliceWithSeam(lines, blocks[i].start, blocks[i].end, [])
  }
  return {
    text: finish(lines),
    removed: blocks.length,
    unbalanced: blocks.some((item) => item.unbalanced),
  }
}

/** 渲染一份带稳定标记的规则块。 */
export function renderPluginBlock(body) {
  return `${START_MARKER}\n\n${String(body).trim()}\n\n${END_MARKER}`
}
