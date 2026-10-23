/**
 * cli-args.mjs — CLI 参数解析（可单测，不碰进程状态）。
 *
 * 约定：`--files` 每次只接受一个路径，可重复；不做逗号切分
 * （路径里合法含逗号，切分属于静默数据损坏）。需要多个文件就重复传。
 */

const FLAGS_WITH_VALUE = new Map([
  ['-g', 'goal'], ['--goal', 'goal'],
  ['-C', 'cwd'], ['--cwd', 'cwd'],
  ['-m', 'mode'], ['--mode', 'mode'],
  ['-f', 'files'], ['--files', 'files'], ['--file', 'files'],
  ['--context', 'context'],
  ['-c', 'constraints'], ['--constraint', 'constraints'],
  ['-a', 'acceptance'], ['--acceptance', 'acceptance'],
  ['-s', 'session'], ['--session', 'session'],
  ['-t', 'timeout_s'], ['--timeout', 'timeout_s'],
])

const LIST_FIELDS = new Set(['files', 'constraints', 'acceptance'])

export function parseArgs(argv) {
  const opts = { files: [], constraints: [], acceptance: [], json: false, help: false }
  const positional = []
  const errors = []

  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i]

    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (arg === '-h' || arg === '--help') {
      opts.help = true
      continue
    }
    if (arg === '--json') {
      opts.json = true
      continue
    }

    let inlineValue
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=')
      inlineValue = arg.slice(eq + 1)
      arg = arg.slice(0, eq)
    }

    const field = FLAGS_WITH_VALUE.get(arg)
    if (!field) {
      if (arg.startsWith('-')) errors.push(`未知参数: ${arg}`)
      else positional.push(argv[i])
      continue
    }

    let value = inlineValue
    if (value === undefined) {
      value = argv[i + 1]
      if (value === undefined) {
        errors.push(`${arg} 缺少取值`)
        continue
      }
      i += 1
    }

    if (LIST_FIELDS.has(field)) {
      // 单个路径原样保留，不做逗号切分。
      opts[field].push(value)
    } else if (field === 'timeout_s') {
      opts.timeout_s = value
    } else {
      opts[field] = value
    }
  }

  return { opts, positional, errors }
}

export const HELP_TEXT = `用法: dsh-task --goal "任务目标" [选项]

  -g, --goal <text>         必须：要交付的结果
  -C, --cwd <dir>           工作目录（edit 模式的写入边界）
  -m, --mode <analyze|edit> 默认 analyze（只读）
  -f, --files <path>        相关文件；可重复，每个参数一个路径（不按逗号切分）
      --context <text>      背景信息
  -c, --constraint <text>   限制条件，可重复
  -a, --acceptance <text>   验收标准，可重复
  -s, --session <label>     复用同名 DSH 会话（保留上下文）；省略=全新会话
  -t, --timeout <sec>       超时，默认 600
      --json                输出机器可读结果（含 status / warnings）
`
