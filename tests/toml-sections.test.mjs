import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MANAGED_COMMENT_PREFIX,
  TomlScanError,
  extractOwnedRegion,
  findOwnedRegions,
  isOwnedTableName,
  parseTableHeader,
  removeOwnedRegions,
  replaceOwnedRegions,
  scanToml,
  stringAssignments,
  tomlArray,
  tomlString,
} from '../lib/toml-sections.mjs'

const BASE = 'mcp_servers.dsh'

const join = (...lines) => lines.join('\n')

/* ---------------------------------------------- 场景1：尾注释的邻表不能被吞 */

test('尾注释邻表：区域在下一个无关表头前结束', () => {
  const text = join(
    'model = "user-default"',
    '',
    '[mcp_servers.dsh]',
    'command = "/old/node"',
    '',
    '[mcp_servers.other] # user comment',
    'command = "MUST KEEP"',
    '',
  )
  const regions = findOwnedRegions(text, BASE)
  assert.equal(regions.length, 1)
  const lines = text.split('\n')
  assert.equal(lines[regions[0].start], '[mcp_servers.dsh]')
  assert.equal(lines[regions[0].end], '[mcp_servers.other] # user comment')
  assert.equal(
    extractOwnedRegion(text, BASE),
    join('[mcp_servers.dsh]', 'command = "/old/node"'),
  )
})

test('尾注释邻表：删除/替换不越过邻表，用户文字保留', () => {
  const text = join(
    'model = "user-default"',
    '',
    '[mcp_servers.dsh]',
    'command = "/old/node"',
    '',
    '[mcp_servers.other] # user comment',
    'command = "MUST KEEP"',
    '',
  )
  const removed = removeOwnedRegions(text, BASE)
  assert.equal(removed.removed, 1)
  assert.ok(removed.text.includes('MUST KEEP'))
  assert.ok(removed.text.includes('# user comment'))
  assert.ok(removed.text.includes('model = "user-default"'))
  assert.ok(!removed.text.includes('[mcp_servers.dsh]'))

  const replaced = replaceOwnedRegions(text, BASE, join('[mcp_servers.dsh]', 'command = "/new/node"'))
  assert.equal(replaced.replaced, 1)
  assert.equal(replaced.duplicates, 0)
  assert.ok(replaced.text.includes('command = "/new/node"'))
  assert.ok(replaced.text.includes('MUST KEEP'))
  assert.ok(replaced.text.includes('# user comment'))
})

test('尾注释邻表：lastSignificant 之后的注释不参与区域边界', () => {
  const text = join('[mcp_servers.dsh]', 'command = "x"', '[mcp_servers.other]# tight', 'command = "y"')
  assert.equal(findOwnedRegions(text, BASE).length, 1)
  assert.equal(findOwnedRegions(text, BASE)[0].end, 2)
})

/* ---------------------------- 场景2：单双引号等价键、重复表与带点 quoted 键 */

test('单双引号等价键：两种写法都识别为同一归属区域', () => {
  const text = join(
    '[mcp_servers."dsh"] # alternate valid spelling',
    'command = "old"',
    'enabled = false',
    "[mcp_servers.'dsh'.env]",
    'EXTRA_KEEP = "preserve-extra"',
    '',
  )
  const scan = scanToml(text)
  assert.deepEqual(
    scan.headers.map((header) => header.name),
    ['mcp_servers.dsh', 'mcp_servers.dsh.env'],
  )
  assert.deepEqual(scan.headers[0].path, ['mcp_servers', 'dsh'])
  const regions = findOwnedRegions(text, BASE)
  assert.equal(regions.length, 1, '主表与子表属于同一区域')
  assert.equal(regions[0].start, 0)
  assert.equal(regions[0].end, text.split('\n').length)
})

test('单双引号等价键：parseTableHeader 返回可比规范名', () => {
  assert.equal(parseTableHeader('[mcp_servers."dsh"]').name, 'mcp_servers.dsh')
  assert.equal(parseTableHeader("[mcp_servers.'dsh']").name, 'mcp_servers.dsh')
  assert.equal(parseTableHeader('[mcp_servers."dsh"] # alternate').name, 'mcp_servers.dsh')
  assert.equal(parseTableHeader('[agents."architecture_designer"]').name, 'agents.architecture_designer')
  assert.deepEqual(parseTableHeader('[a.b."c.d"]').path, ['a', 'b', 'c.d'])
  assert.equal(parseTableHeader('[plugins."computer-use@openai-bundled"]').name, 'plugins."computer-use@openai-bundled"')
  assert.deepEqual(parseTableHeader('[[x.y]]'), { name: 'x.y', path: ['x', 'y'], array: true })
  assert.equal(parseTableHeader('key = "v"'), undefined)
  assert.equal(parseTableHeader('[a] [b]'), undefined)
})

test('带点 quoted 键不是子表', () => {
  const text = join('[mcp_servers."other.dsh"]', 'command = "keep"', '')
  assert.deepEqual(scanToml(text).headers[0].path, ['mcp_servers', 'other.dsh'])
  assert.equal(isOwnedTableName('mcp_servers."other.dsh"', BASE), false)
  assert.deepEqual(findOwnedRegions(text, BASE), [])

  const envKey = join('[mcp_servers."dsh.env"]', 'KEEP = "x"', '')
  assert.deepEqual(findOwnedRegions(envKey, BASE), [])

  const agentBase = 'agents."architecture_designer"'
  assert.equal(isOwnedTableName('agents."architecture_designer"', agentBase), true)
  assert.equal(isOwnedTableName('agents.architecture_designer', agentBase), true)
  assert.equal(isOwnedTableName('agents."architecture_designer.v2"', agentBase), false)
  assert.equal(isOwnedTableName('mcp_servers.dsh_extra', BASE), false)
  assert.equal(isOwnedTableName('mcp_servers.dsh.env.deep', BASE), true)
})

test('重复归属表：分成两段区域并可合并删除', () => {
  const text = join(
    '[mcp_servers.dsh]',
    'command = "one"',
    '',
    '[mcp_servers.other]',
    'command = "keep"',
    '',
    '[mcp_servers.dsh]',
    'command = "two"',
    '',
  )
  const regions = findOwnedRegions(text, BASE)
  assert.equal(regions.length, 2)
  const replaced = replaceOwnedRegions(text, BASE, join('[mcp_servers.dsh]', 'command = "new"'))
  assert.equal(replaced.replaced, 2)
  assert.equal(replaced.duplicates, 1)
  assert.equal(replaced.text.match(/\[mcp_servers\.dsh\]/g).length, 1)
  assert.ok(replaced.text.includes('command = "keep"'))
})

/* ------------------------------------ 场景3：多行字符串里的伪表头不能识别 */

test('多行 basic 字符串里的伪表头被跳过', () => {
  const instructions = 'Example syntax follows:\n[mcp_servers.dsh]\ncommand="EXAMPLE ONLY"\n'
  const text = join(
    'model = "k"',
    '',
    '[agents.documentation]',
    'developer_instructions = """',
    'Example syntax follows:',
    '[mcp_servers.dsh]',
    'command="EXAMPLE ONLY"',
    '"""',
    '',
  )
  const scan = scanToml(text)
  assert.deepEqual(scan.headers.map((header) => header.name), ['agents.documentation'])
  assert.deepEqual(findOwnedRegions(text, BASE), [])

  const replaced = replaceOwnedRegions(text, BASE, join('[mcp_servers.dsh]', 'command = "/new/node"'))
  assert.equal(replaced.replaced, 0)
  assert.ok(replaced.text.includes(`developer_instructions = """\n${instructions}"""`), '多行字符串内容原样保留')
})

test('多行 literal 字符串里的伪表头被跳过', () => {
  const text = join(
    '[agents.documentation]',
    "notes = '''",
    '[mcp_servers.dsh]',
    "command = 'EXAMPLE ONLY'",
    "'''",
    '[keep_me]',
    'value = 1',
    '',
  )
  assert.deepEqual(scanToml(text).headers.map((header) => header.name), ['agents.documentation', 'keep_me'])
  assert.deepEqual(findOwnedRegions(text, BASE), [])
  const removed = removeOwnedRegions(text, BASE)
  assert.equal(removed.removed, 0)
  assert.equal(removed.text, text)
})

test('注释里的伪表头被跳过', () => {
  const text = join('# [mcp_servers.dsh] is documented below', '[mcp_servers.other]', 'command = "x"', '')
  assert.deepEqual(scanToml(text).headers.map((header) => header.name), ['mcp_servers.other'])
})

test('basic 字符串里的转义引号不提前结束字符串', () => {
  const text = join('command = "C:\\\\some \\"quoted\\" dir"', '[mcp_servers.other]', 'command = "keep"', '')
  const scan = scanToml(text)
  assert.deepEqual(scan.headers.map((header) => header.name), ['mcp_servers.other'])
  assert.equal(scan.assignments[0].line, 1)
})

/* ------------------------------------------- 数组 / 内联表：值区间与不误识别 */

test('数组与内联表：多行值区间正确、内容不误识别为表头', () => {
  const text = join(
    'args = [',
    '  "[mcp_servers.dsh]",',
    '  { a = 1 }, # comment with [mcp_servers.dsh]',
    ']',
    '',
    '[mcp_servers.dsh]',
    'command = "x"',
    '',
  )
  const scan = scanToml(text)
  assert.equal(scan.headers.length, 1)
  assert.equal(scan.headers[0].name, BASE)
  const [assignment] = scan.assignments
  assert.equal(assignment.name, 'args')
  assert.equal(assignment.valueStart, 'args = '.length)
  assert.equal(text.slice(assignment.valueStart, assignment.valueEnd),
    '[\n  "[mcp_servers.dsh]",\n  { a = 1 }, # comment with [mcp_servers.dsh]\n]')
  assert.equal(assignment.line, 1)
  assert.equal(findOwnedRegions(text, BASE).length, 1)
})

test('赋值区间：start/end/valueStart/valueEnd 与源码一致', () => {
  const text = join('[mcp_servers.dsh]', '  command = "node" # trailing', 'startup_timeout_sec = 30', '')
  const scan = scanToml(text)
  const [command, timeout] = scan.assignments
  assert.equal(text.slice(command.start, command.end), 'command = "node"')
  assert.equal(text.slice(command.valueStart, command.valueEnd), '"node"')
  assert.equal(command.table, BASE)
  assert.deepEqual(command.tablePath, ['mcp_servers', 'dsh'])
  assert.equal(text.slice(timeout.start, timeout.end), 'startup_timeout_sec = 30')
  assert.equal(text.slice(timeout.valueStart, timeout.valueEnd), '30')
  const [header] = scan.headers
  assert.equal(text.slice(header.start, header.end), '[mcp_servers.dsh]')
  assert.equal(header.line, 1)
})

test('点分键赋值与数组表头', () => {
  const text = join('mcp_servers.dsh.command = "x"', '[[bin]]', 'name = "n"', '')
  const scan = scanToml(text)
  assert.deepEqual(scan.assignments[0].path, ['mcp_servers', 'dsh', 'command'])
  assert.deepEqual(scan.headers.map((header) => [header.name, header.array]), [['bin', true]])
})

test('CRLF 与行首缩进不影响表头/赋值识别', () => {
  const text = '[mcp_servers.dsh]\r\n  command = "x"\r\n[mcp_servers.other]\r\ncommand = "y"\r\n'
  const regions = findOwnedRegions(text, BASE)
  assert.equal(regions.length, 1)
  assert.equal(regions[0].end, 2)
  const scan = scanToml(text)
  assert.equal(text.slice(scan.assignments[0].valueStart, scan.assignments[0].valueEnd), '"x"')
})

/* ------------------------------------------------------------ 安全失败与吸收 */

test('无法确定边界时抛出带 code/line 的错误，且不带配置值', () => {
  const sentinel = 'SENTINEL_SECRET_VALUE'
  assert.throws(
    () => scanToml(`key = "${sentinel}\n`),
    (error) => {
      assert.ok(error instanceof TomlScanError)
      assert.equal(error.code, 'TOML_UNTERMINATED_STRING')
      assert.equal(error.line, 1)
      assert.ok(!error.message.includes(sentinel), '错误消息不输出配置值')
      return true
    },
  )
  assert.throws(
    () => scanToml(join('[a]', 'x = [1, 2', '')),
    (error) => error.code === 'TOML_UNCLOSED_VALUE' && error.line >= 2,
  )
  assert.throws(
    () => scanToml(join('[a]', 'x = "unclosed', '')),
    (error) => error.code === 'TOML_UNTERMINATED_STRING' && error.line === 2,
  )
  assert.throws(() => scanToml('[a\nb]\n'), (error) => error.code === 'TOML_INVALID_HEADER')
})

test('归属区域向前吸收本插件注释，不吸收用户注释', () => {
  const text = join(
    '# user note about the section below',
    `${MANAGED_COMMENT_PREFIX} 注册段（v2 生成）`,
    `${MANAGED_COMMENT_PREFIX} 不要手改`,
    '[mcp_servers.dsh]',
    'command = "x"',
    '',
  )
  const [region] = findOwnedRegions(text, BASE)
  assert.equal(region.start, 1)
  assert.ok(!extractOwnedRegion(text, BASE).includes('user note'))

  const noComment = join('[mcp_servers.dsh]', 'command = "x"', '')
  assert.equal(findOwnedRegions(noComment, BASE)[0].start, 0)
  assert.deepEqual(findOwnedRegions(join('model = "x"', ''), BASE), [])
})

test('字符串内部的行首不会被当作本插件注释吸收', () => {
  const text = join(
    '[agents.documentation]',
    'notes = """first',
    `${MANAGED_COMMENT_PREFIX} fake """`,
    '[mcp_servers.dsh]',
    'command = "x"',
    '',
  )
  const [region] = findOwnedRegions(text, BASE)
  assert.equal(text.split('\n')[region.start], '[mcp_servers.dsh]')
})

/* ---------------------------------------------------------------- 保留接口 */

test('tomlString / tomlArray / stringAssignments 保留原有行为', () => {
  assert.equal(tomlString('C:\\dir with "quote"'), '"C:\\\\dir with \\"quote\\""')
  assert.equal(tomlArray(['a', 'b']), '["a", "b"]')
  const text = join('[t]', "a = 'literal'", 'b = "basic\\"escaped"', 'c = 30', 'd = """multi', 'line"""', '')
  const values = stringAssignments(text)
  assert.equal(values.get('a'), 'literal')
  assert.equal(values.get('b'), 'basic"escaped')
  assert.equal(values.has('c'), false)
  assert.equal(values.has('d'), false, '多行字符串不做取值猜测')
})
