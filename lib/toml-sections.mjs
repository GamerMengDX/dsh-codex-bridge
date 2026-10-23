/**
 * toml-sections.mjs — 只维护「本插件拥有的 TOML 表」的最小工具集，零依赖、无完整 TOML 解析。
 * English: a dependency-free lexical scanner and source-range helpers for managed TOML.
 * String, comment, and container state keep apparent headings inside values from
 * becoming real tables. Decoded key segments distinguish quoted dots from child paths.
 * This is not a full TOML validator; uncertain target structures must fail conservatively.
 *
 * 用途：
 * - 生成 Codex `config.toml` 里的 `[mcp_servers.dsh]`（含其子表 `[mcp_servers.dsh.env]`）；
 * - 生成/替换/删除 `[agents."architecture_designer"]` 这样的一段。
 *
 * 边界（防止误删邻居）：一个归属区域从上表头开始，只延伸到这个表**自己**的子表为止，
 * 遇到任何别的表头就结束。删除/替换永远不会越过下一个无关表（例如用户后面的
 * `[mcp_servers.other]`、`[plugins...]`）。表头匹配按**解码后的键段**比较，所以
 * `[mcp_servers."dsh"]` / `[mcp_servers.'dsh'.env]` 与 `[mcp_servers.dsh]` 等价，
 * 而带点的 quoted 单键（`[mcp_servers."other.dsh"]`）不会被当成子表。
 *
 * 扫描（v1.1）：`scanToml` 是带词法状态的单遍扫描器，逐个字符跟踪普通/多行 basic、
 * 普通/多行 literal 字符串、转义、注释、数组/内联表深度，只在语句层识别表头与赋值，
 * 并为每个结果给出 [start, end) 源码字符偏移，供后续字段级区间补丁使用。
 * 语法无法确定边界时抛 `TomlScanError`（带 code/line），不猜测、不吞用户内容。
 */

const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/
const BARE_KEY_CHAR_RE = /[A-Za-z0-9_-]/
const WHITESPACE_RE = /[ \t]/

const STATE_CODE = 0
const STATE_BASIC = 1
const STATE_ML_BASIC = 2
const STATE_LITERAL = 3
const STATE_ML_LITERAL = 4
const STATE_COMMENT = 5

const SIMPLE_ESCAPES = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
}

/** 扫描失败：带机器可读 code 与 1 基行号；消息里不包含任何配置值。 */
export class TomlScanError extends Error {
  constructor(code, line, message) {
    super(`${message}（code=${code}, line=${line}）`)
    this.name = 'TomlScanError'
    this.code = code
    this.line = line
  }
}

function fail(code, line, message) {
  throw new TomlScanError(code, line, message)
}

/** 把键段渲染成可比较的规范写法：安全段用裸键，其余用双引号（含点的段必然带引号）。 */
export function renderKeyPath(path) {
  if (!Array.isArray(path) || path.length === 0) return ''
  return path.map((segment) => (BARE_KEY_RE.test(segment) ? segment : quoteKeySegment(segment))).join('.')
}

function quoteKeySegment(segment) {
  const escaped = String(segment)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u001f\u007f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return `"${escaped}"`
}

/** 解析 `"..."` 形式的键段（单行，允许转义）。 */
function readBasicKey(src, at, line) {
  const len = src.length
  let j = at + 1
  let out = ''
  while (j < len) {
    const ch = src[j]
    if (ch === '\n') fail('TOML_INVALID_KEY', line, '带引号的键不能跨行')
    if (ch === '"') return { value: out, end: j + 1 }
    if (ch === '\\') {
      const next = src[j + 1]
      if (Object.hasOwn(SIMPLE_ESCAPES, next)) {
        out += SIMPLE_ESCAPES[next]
        j += 2
        continue
      }
      if (next === 'u' || next === 'U') {
        const size = next === 'u' ? 4 : 8
        const hex = src.slice(j + 2, j + 2 + size)
        if (hex.length !== size || !/^[0-9A-Fa-f]+$/.test(hex)) fail('TOML_INVALID_ESCAPE', line, '键中的转义不合法')
        out += String.fromCodePoint(Number.parseInt(hex, 16))
        j += 2 + size
        continue
      }
      fail('TOML_INVALID_ESCAPE', line, '键中的转义不合法')
    }
    out += ch
    j += 1
  }
  fail('TOML_INVALID_KEY', line, '带引号的键没有结束引号')
}

/** 解析 `'...'` 形式的键段（单行，无转义）。 */
function readLiteralKey(src, at, line) {
  const len = src.length
  let j = at + 1
  while (j < len) {
    const ch = src[j]
    if (ch === '\n') fail('TOML_INVALID_KEY', line, '带引号的键不能跨行')
    if (ch === "'") return { value: src.slice(at + 1, j), end: j + 1 }
    j += 1
  }
  fail('TOML_INVALID_KEY', line, '带引号的键没有结束引号')
}

/** 解析点分键路径（单行），返回解码后的键段数组与结束偏移。 */
function readKeyPath(src, at, line) {
  const len = src.length
  const path = []
  let j = at
  for (;;) {
    while (j < len && WHITESPACE_RE.test(src[j])) j += 1
    const ch = src[j]
    if (ch === '"') {
      const segment = readBasicKey(src, j, line)
      path.push(segment.value)
      j = segment.end
    } else if (ch === "'") {
      const segment = readLiteralKey(src, j, line)
      path.push(segment.value)
      j = segment.end
    } else {
      let k = j
      while (k < len && BARE_KEY_CHAR_RE.test(src[k])) k += 1
      if (k === j) fail('TOML_INVALID_KEY', line, '无法解析键')
      path.push(src.slice(j, k))
      j = k
    }
    while (j < len && WHITESPACE_RE.test(src[j])) j += 1
    if (src[j] === '.') {
      j += 1
      continue
    }
    break
  }
  return { path, end: j }
}

/** 解析一处表头（`[a.b]` / `[[a.b]]`），返回键段、是否数组表与区间。 */
function readTableHeader(src, at, line) {
  const len = src.length
  const array = src[at + 1] === '['
  const key = readKeyPath(src, at + (array ? 2 : 1), line)
  let j = key.end
  while (j < len && WHITESPACE_RE.test(src[j])) j += 1
  if (array) {
    if (src[j] !== ']' || src[j + 1] !== ']') fail('TOML_INVALID_HEADER', line, '数组表头缺少 ]]')
    j += 2
  } else {
    if (src[j] !== ']') fail('TOML_INVALID_HEADER', line, '表头缺少 ]')
    j += 1
  }
  return { path: key.path, array, start: at, end: j }
}

/**
 * 零依赖有状态扫描。
 *
 * @param {string} text
 * @returns {{
 *   headers: Array<{name: string, path: string[], array: boolean, start: number, end: number, line: number}>,
 *   assignments: Array<{name: string, path: string[], table: string, tablePath: string[], start: number,
 *     end: number, line: number, valueStart: number, valueEnd: number}>,
 *   stringSpans: Array<{start: number, end: number}>,
 *   lineStarts: number[],
 * }}
 * 所有偏移都是 [start, end) 的源码字符偏移；line 为 1 基行号。表头/赋值只在语句层识别，
 * 多行字符串、注释与数组/内联表内部的伪表头不会被当成表头。
 * @throws {TomlScanError} 遇到无法确定边界的语法时抛出（含 code 与 line）。
 */
export function scanToml(text) {
  const src = String(text ?? '')
  const len = src.length
  const headers = []
  const assignments = []
  const stringSpans = []
  const lineStarts = [0]
  for (let k = 0; k < len; k += 1) if (src[k] === '\n') lineStarts.push(k + 1)

  let state = STATE_CODE
  let depth = 0
  let line = 1
  let i = 0
  let tablePath = []
  let stmt
  let stringStartLine = 0
  let stringSpanStart = 0

  const skipToLineEnd = () => {
    while (i < len && src[i] !== '\n') i += 1
  }

  const closeString = (endIndex) => {
    state = STATE_CODE
    stringSpans.push({ start: stringSpanStart, end: endIndex })
    if (stmt) stmt.lastSignificant = endIndex - 1
  }

  const endStatement = () => {
    if (!stmt || depth > 0) return
    const end = Math.max(stmt.valueStart, stmt.lastSignificant + 1)
    assignments.push({
      name: renderKeyPath(stmt.path),
      path: stmt.path,
      table: renderKeyPath(tablePath),
      tablePath,
      start: stmt.start,
      end,
      line: stmt.line,
      valueStart: stmt.valueStart,
      valueEnd: end,
    })
    stmt = undefined
  }

  while (i < len) {
    const ch = src[i]

    if (state === STATE_COMMENT) {
      if (ch === '\n') {
        state = STATE_CODE
        endStatement()
        line += 1
      }
      i += 1
      continue
    }

    if (state === STATE_BASIC || state === STATE_LITERAL) {
      if (ch === '\n') fail('TOML_UNTERMINATED_STRING', stringStartLine, '单行字符串没有结束引号')
      if (state === STATE_BASIC && ch === '\\') {
        if (src[i + 1] === '\n') line += 1
        i += 2
        continue
      }
      if (state === STATE_BASIC && ch === '"') {
        closeString(i + 1)
        i += 1
        continue
      }
      if (state === STATE_LITERAL && ch === "'") {
        closeString(i + 1)
        i += 1
        continue
      }
      i += 1
      continue
    }

    if (state === STATE_ML_BASIC || state === STATE_ML_LITERAL) {
      const quote = state === STATE_ML_BASIC ? '"' : "'"
      if (state === STATE_ML_BASIC && ch === '\\') {
        if (src[i + 1] === '\n') line += 1
        i += 2
        continue
      }
      if (ch === quote) {
        let run = 0
        while (src[i + run] === quote) run += 1
        if (run >= 3) {
          const total = 3 + Math.min(run - 3, 2)
          closeString(i + total)
          i += total
          continue
        }
        i += run
        continue
      }
      if (ch === '\n') line += 1
      i += 1
      continue
    }

    /* ------------------------------- 语句层（普通代码） ------------------------------- */

    if (ch === '\n') {
      endStatement()
      line += 1
      i += 1
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1
      continue
    }

    if (stmt) {
      if (ch === '"' || ch === "'") {
        const triple = ch === '"' ? '"""' : "'''"
        stringSpanStart = i
        stringStartLine = line
        if (src.startsWith(triple, i)) {
          state = ch === '"' ? STATE_ML_BASIC : STATE_ML_LITERAL
          i += 3
        } else {
          state = ch === '"' ? STATE_BASIC : STATE_LITERAL
          i += 1
        }
        continue
      }
      if (ch === '#') {
        state = STATE_COMMENT
        i += 1
        continue
      }
      if (ch === '[' || ch === '{') {
        depth += 1
        stmt.lastSignificant = i
        i += 1
        continue
      }
      if (ch === ']' || ch === '}') {
        if (depth === 0) fail('TOML_UNBALANCED_VALUE', line, '值中出现了多余的右括号')
        depth -= 1
        stmt.lastSignificant = i
        i += 1
        continue
      }
      stmt.lastSignificant = i
      i += 1
      continue
    }

    if (ch === '#') {
      state = STATE_COMMENT
      i += 1
      continue
    }

    if (ch === '[') {
      const header = readTableHeader(src, i, line)
      let k = header.end
      while (k < len && (src[k] === ' ' || src[k] === '\t' || src[k] === '\r')) k += 1
      if (k < len && src[k] !== '\n' && src[k] !== '#') fail('TOML_INVALID_HEADER', line, '表头行有多余内容')
      headers.push({
        name: renderKeyPath(header.path),
        path: header.path,
        array: header.array,
        start: header.start,
        end: header.end,
        line,
      })
      tablePath = header.path
      i = header.end
      continue
    }

    if (ch === '"' || ch === "'" || BARE_KEY_CHAR_RE.test(ch)) {
      const key = readKeyPath(src, i, line)
      let j = key.end
      while (j < len && WHITESPACE_RE.test(src[j])) j += 1
      if (src[j] !== '=') {
        skipToLineEnd()
        continue
      }
      let valueStart = j + 1
      while (valueStart < len && WHITESPACE_RE.test(src[valueStart])) valueStart += 1
      if (valueStart >= len || src[valueStart] === '\n' || src[valueStart] === '#') {
        fail('TOML_MISSING_VALUE', line, '赋值缺少值')
      }
      stmt = { start: i, path: key.path, valueStart, lastSignificant: valueStart, line }
      i = valueStart
      continue
    }

    skipToLineEnd()
  }

  if (stmt) endStatement()
  if (state === STATE_BASIC || state === STATE_LITERAL) {
    fail('TOML_UNTERMINATED_STRING', stringStartLine, '单行字符串没有结束引号')
  }
  if (state === STATE_ML_BASIC || state === STATE_ML_LITERAL) {
    fail('TOML_UNTERMINATED_STRING', stringStartLine, '多行字符串没有结束引号')
  }
  if (depth > 0) fail('TOML_UNCLOSED_VALUE', line, '数组或内联表没有闭合')

  return { headers, assignments, stringSpans, lineStarts }
}

/* ---------------------------------------------------------------- 字符串编码 */

/** TOML basic string：转义反斜杠、引号、换行、制表符与控制字符（路径里常见 `\` 与空格）。 */
export function tomlString(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (ch) => {
      return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
    })
  return `"${escaped}"`
}

/** TOML 数组（一行一个元素，便于 diff）。 */
export function tomlArray(values) {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`
}

/* ---------------------------------------------------------------- 表名比较 */

function toKeyPath(value) {
  if (Array.isArray(value)) return value.map((segment) => String(segment))
  try {
    return readKeyPath(String(value ?? ''), 0, 1).path
  } catch {
    return undefined
  }
}

function isPathWithin(path, basePath) {
  if (!Array.isArray(path) || !Array.isArray(basePath)) return false
  if (path.length === 0 || basePath.length === 0) return false
  if (path.length < basePath.length) return false
  for (let i = 0; i < basePath.length; i += 1) {
    if (path[i] !== basePath[i]) return false
  }
  return true
}

/**
 * 解析单行表头，返回可比规范名 `name`、解码键段 `path` 与是否数组表。
 * 支持单/双引号 dotted keys 与尾注释；无法解析时返回 undefined（不抛错，便于逐行判定）。
 */
export function parseTableHeader(line) {
  const text = String(line ?? '')
  let at = 0
  while (at < text.length && (text[at] === ' ' || text[at] === '\t')) at += 1
  if (text[at] !== '[') return undefined
  let header
  try {
    header = readTableHeader(text, at, 1)
  } catch {
    return undefined
  }
  let k = header.end
  while (k < text.length && (text[k] === ' ' || text[k] === '\t' || text[k] === '\r')) k += 1
  if (k < text.length && text[k] !== '#') return undefined
  return { name: renderKeyPath(header.path), path: header.path, array: header.array }
}

/** `name` 是否就是 `base` 或它的子表：按解码后的键段逐段比较，带点的 quoted 单键不算子表。 */
export function isOwnedTableName(name, base) {
  const namePath = toKeyPath(name)
  const basePath = toKeyPath(base)
  if (!namePath || !basePath) return false
  return isPathWithin(namePath, basePath)
}

/** 本插件生成的注释行：统一以 `# dsh-codex-bridge:` 开头，便于精确识别与清理。 */
export const MANAGED_COMMENT_PREFIX = '# dsh-codex-bridge:'

const MANAGED_COMMENT_RE = /^\s*#\s*-*\s*dsh-codex-bridge\b/i

/** 该行（从 offset 起的整行）是否本插件注释行，且该行开头不在任何字符串内部。 */
function isManagedCommentLine(src, offset, scan) {
  const newline = src.indexOf('\n', offset)
  const lineText = src.slice(offset, newline === -1 ? src.length : newline)
  if (!MANAGED_COMMENT_RE.test(lineText)) return false
  for (const span of scan.stringSpans) {
    if (span.start >= offset) break
    if (offset < span.end) return false
  }
  return true
}

/**
 * 找出所有归属区域（行区间，end 不含，0 基行号）。
 * 使用 scanToml 的真实表头（跳过字符串/注释里的伪表头），按解码键段判定归属。
 * `start` 会向前吸收连续的「本插件生成的注释行」（只在字符串之外吸收）。
 */
export function findOwnedRegions(text, base) {
  const src = String(text ?? '')
  const scan = scanToml(src)
  const lineStarts = scan.lineStarts
  const lineCount = lineStarts.length
  const basePath = toKeyPath(base)
  const regions = []
  let current

  for (const header of scan.headers) {
    if (!isPathWithin(header.path, basePath)) {
      if (current) {
        current.end = Math.max(current.start, header.line - 1)
        regions.push(current)
        current = undefined
      }
      continue
    }
    if (current) continue // 归属表自己的子表，属于同一区域
    let start = header.line - 1
    while (start - 1 >= 0 && isManagedCommentLine(src, lineStarts[start - 1], scan)) start -= 1
    current = { start, end: lineCount }
  }
  if (current) {
    current.end = lineCount
    regions.push(current)
  }
  return regions
}

/** 取第一处归属区域的原文（用于 --check 比较 / 卸载判断）。 */
export function extractOwnedRegion(text, base) {
  const lines = String(text).split('\n')
  const [region] = findOwnedRegions(text, base)
  if (!region) return undefined
  return lines.slice(region.start, region.end).join('\n').replace(/\s+$/, '')
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
 * 用 `block` 替换所有归属区域：第一处原位替换（保留位置），其余重复表删除。
 * 只调整接缝处的空行；文件其他部分的空行与格式原样保留。
 * @returns {{text: string, replaced: number, duplicates: number}}
 */
export function replaceOwnedRegions(text, base, block) {
  const source = String(text ?? '')
  const blockLines = String(block).replace(/^\s+/, '').replace(/\s+$/, '').split('\n')
  const regions = findOwnedRegions(source, base)

  if (!regions.length) {
    const lines = source.split('\n')
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    const out = lines.length ? [...lines, '', ...blockLines] : [...blockLines]
    return { text: finish(out), replaced: 0, duplicates: 0 }
  }

  let lines = source.split('\n')
  for (let i = regions.length - 1; i >= 0; i -= 1) {
    const insert = i === 0 ? blockLines : []
    lines = spliceWithSeam(lines, regions[i].start, regions[i].end, insert)
  }
  return {
    text: finish(lines),
    replaced: regions.length,
    duplicates: Math.max(0, regions.length - 1),
  }
}

/**
 * 删除所有归属区域。
 * @returns {{text: string, removed: number}}
 */
export function removeOwnedRegions(text, base) {
  const source = String(text ?? '')
  const regions = findOwnedRegions(source, base)
  if (!regions.length) return { text: source, removed: 0 }

  let lines = source.split('\n')
  for (let i = regions.length - 1; i >= 0; i -= 1) {
    lines = spliceWithSeam(lines, regions[i].start, regions[i].end, [])
  }
  return { text: finish(lines), removed: regions.length }
}

/** 解析某段文本里 `key = "value"` 的字符串取值（只用于状态报告，不做权威 TOML 解析）。 */
export function stringAssignments(text) {
  const src = String(text ?? '')
  const out = new Map()
  for (const item of scanToml(src).assignments) {
    const raw = src.slice(item.valueStart, item.valueEnd)
    let parsed
    try {
      if (raw.startsWith('"')) parsed = readBasicKey(src, item.valueStart, item.line)
      else if (raw.startsWith("'")) parsed = readLiteralKey(src, item.valueStart, item.line)
      else continue
    } catch {
      continue
    }
    if (parsed.end !== item.valueEnd) continue // 多行/拼接等非单一字符串取值，不做猜测
    out.set(item.name, parsed.value)
  }
  return out
}
