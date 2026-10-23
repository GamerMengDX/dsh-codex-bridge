#!/usr/bin/env node
/**
 * install-codex.mjs — 把多 Agent 协作系统安装进 Codex（可重复执行、自动备份、可安全卸载）。
 * English: installs the managed Codex role, Skills, and guidance block.
 * Installation records and protected backups support restoration. Damaged markers,
 * uncertain ownership, and user edits are preserved instead of removed speculatively.
 * This file does not implement DSH task execution or choose the user's default model.
 *
 *   node install-codex.mjs                # 安装 / 更新（跨版本升级也走这里）
 *   node install-codex.mjs --check        # 只读检查；未安装、需要更新或出错时退出码 1
 *   node install-codex.mjs --dry-run      # 打印将要改动的文件，不写任何东西
 *   node install-codex.mjs --uninstall    # 只移除本插件安装的内容（可重复执行）
 *   node install-codex.mjs --codex-home ~/.codex-alt
 *   node install-codex.mjs --codex-bin /path/to/codex   # 显式指定 codex（否则走 PATH / 应用目录发现）
 *   node install-codex.mjs --no-doctor    # 跳过 codex doctor 校验
 *
 * 安全边界：
 * - 只改：agents/architecture_designer.toml、config.toml 的 [agents."architecture_designer"]、
 *   skills/{multi-agent-development,dsh-bridge}/SKILL.md、AGENTS.md 的标记块，
 *   以及安装记录 <codexHome>/.dsh-codex-bridge-install.json。
 * - 不改：默认模型、model_provider、登录信息（auth.json）、其他 MCP server、其他 agent 角色、
 *   computer-use 开关、DSH 会话与凭据。
 * - 每个被覆盖的文件先备份为 <file>.bak-dshbridge-<时间戳>（权限 600）。
 * - 规则块用稳定插件标识匹配：v2.2.0 / v2.2.2 的历史块会被替换而不是追加，多个旧块只保留一份。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  END_MARKER,
  START_MARKER,
  analyzePluginBlocks,
  blockText,
  renderPluginBlock,
  stripPluginBlocks,
  upsertPluginBlock,
} from './lib/agents-block.mjs'
import { findOnPath } from './lib/config.mjs'
import {
  createBackup,
  fileRecord,
  hashText,
  looksSecretText,
  manifestPath,
  pruneEmptyDir,
  readManifest,
  releaseFile,
  removeManifest,
  writeManifest,
} from './lib/install-manifest.mjs'
import {
  extractOwnedRegion,
  removeOwnedRegions,
  replaceOwnedRegions,
  tomlString,
} from './lib/toml-sections.mjs'

export { END_MARKER, START_MARKER }

/**
 * 桥接根目录：直接执行时以「被调用的脚本路径」为准，而不是 import.meta.url。
 * 这样 /var ⇄ /private/var 或符号链接目录下运行时，渲染出的路径与用户调用时的路径一致，
 * 不会把同一目录写成两种别名；被 import 时仍按模块自身位置解析。
 */
const ROOT = isMainModule() ? dirname(resolve(process.argv[1])) : dirname(fileURLToPath(import.meta.url))
const ROLE_ID = 'architecture_designer'
const AGENT_TABLE = `agents."${ROLE_ID}"`
const SKILLS = [
  { source: ['codex', 'skills', 'multi-agent-development', 'SKILL.md'], target: ['skills', 'multi-agent-development', 'SKILL.md'], label: 'skill multi-agent-development' },
  { source: ['skill', 'SKILL.md'], target: ['skills', 'dsh-bridge', 'SKILL.md'], label: 'skill dsh-bridge' },
]

/** 版本只有一个来源：package.json。 */
export function readVersion(root = ROOT) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const VERSION = readVersion()

export { hashText }

/* ------------------------------------------------------------ 模板渲染 */

/** Codex 可执行文件：显式配置优先，其次 PATH，最后才是 macOS 应用内置路径。 */
const APP_BUNDLE_CODEX = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
]

export function findCodexBin({ env = process.env, platform = process.platform, explicit } = {}) {
  if (explicit) return { path: resolve(explicit), source: '--codex-bin' }
  const fromEnv = env.CODEX_BIN || env.CODEX_CLI
  if (fromEnv) return { path: resolve(fromEnv), source: 'CODEX_BIN' }
  const onPath = findOnPath(platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'], env, platform)
  if (onPath) return { path: onPath, source: 'PATH' }
  for (const candidate of APP_BUNDLE_CODEX) {
    if (existsSync(candidate)) return { path: candidate, source: 'app-bundle' }
  }
  return undefined
}

export function readRoles(root = ROOT) {
  const file = join(root, 'codex', 'roles.json')
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!parsed.roles?.[ROLE_ID]) throw new Error(`roles.json 缺少 ${ROLE_ID}`)
  return parsed
}

export function renderAgentToml(spec, root = ROOT) {
  const template = readFileSync(join(root, 'codex', 'agents', `${ROLE_ID}.toml.tmpl`), 'utf8')
  return template
    .replace('{{MODEL}}', spec.model)
    .replace('{{REASONING_EFFORT}}', spec.reasoning_effort ?? 'high')
}

export function renderAgentSection(spec, configFile) {
  const nicknames = JSON.stringify(spec.nickname_candidates ?? ['Designer'])
  return `[agents."${ROLE_ID}"]
description = "系统设计角色：架构设计、接口契约、技术选型与疑难诊断；默认只读，不改业务代码。"
config_file = ${tomlString(configFile)}
nickname_candidates = ${nicknames}
`
}

/** 是否为本插件自己生成的（历史版本）角色段，用于避免把旧渲染结果误记成「用户原内容」。 */
export function isOwnAgentSection(text) {
  return /系统设计角色|nickname_candidates\s*=/.test(String(text ?? ''))
}

/** Skill / 规则模板里的可移植占位符（安装时替换为本机真实路径，仓库里保持通用）。 */
export function renderPortableText(text, { root = ROOT, version = VERSION } = {}) {
  const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'"
  return String(text)
    .replaceAll('{{DSH_RUN_CMD}}', shellQuote(join(root, 'dsh-run')))
    .replaceAll('{{DSH_TASK_CMD}}', shellQuote(join(root, 'dsh-task.mjs')))
    .replaceAll('{{TASK_DOC_CMD}}', shellQuote(join(root, 'scripts', 'task-doc.mjs')))
    .replaceAll('{{BRIDGE_ROOT}}', root)
    .replaceAll('{{DSH_RUN}}', join(root, 'dsh-run'))
    .replaceAll('{{DSH_TASK}}', join(root, 'dsh-task.mjs'))
    .replaceAll('{{TASK_DOC}}', join(root, 'scripts', 'task-doc.mjs'))
    .replaceAll('{{VERSION}}', version)
}

/** 兼容旧导出：外部脚本可能直接用 upsertTomlSection 维护一个 TOML 表。 */
export function upsertTomlSection(text, header, body) {
  const name = header.replace(/^\[/, '').replace(/\]$/, '')
  return replaceOwnedRegions(text, name, body).text
}

/** 兼容旧导出：规则块的幂等插入/替换（现由 lib/agents-block.mjs 实现）。 */
export function upsertMarkedBlock(text, block) {
  return upsertPluginBlock(text, block).text
}

/* -------------------------------------------------------------- 期望状态 */

/**
 * 计算「本机此刻应该是什么样」：安装、检查、卸载都用同一份渲染结果，
 * 避免三个入口各写一套路径拼接。
 */
export function desiredState({ codexHome, root = ROOT, version = VERSION } = {}) {
  const roles = readRoles(root)
  const spec = roles.roles[ROLE_ID]
  const agentFile = join(codexHome, 'agents', `${ROLE_ID}.toml`)
  const agentToml = renderAgentToml(spec, root)
  const agentSection = renderAgentSection(spec, agentFile)
  const agentsBody = renderPortableText(readFileSync(join(root, 'codex', 'AGENTS.md.part'), 'utf8').trim(), { root, version })

  const files = [
    { path: agentFile, content: agentToml, label: 'agent role' },
    ...SKILLS.map(({ source, target, label }) => {
      const template = readFileSync(join(root, ...source), 'utf8')
      return {
        path: join(codexHome, ...target),
        content: renderPortableText(template, { root, version }),
        label,
      }
    }),
  ]

  return {
    version,
    codexHome,
    agentFile,
    agentSection,
    block: renderPluginBlock(agentsBody),
    files,
  }
}

/* --------------------------------------------------------------- 主流程 */

function parseArgs(argv) {
  const opts = { check: false, dryRun: false, uninstall: false, doctor: true, codexHome: undefined, codexBin: undefined, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') opts.check = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--uninstall') opts.uninstall = true
    else if (arg === '--no-doctor') opts.doctor = false
    else if (arg === '--codex-home') opts.codexHome = argv[++i]
    else if (arg === '--codex-bin') opts.codexBin = argv[++i]
    else if (arg === '--help' || arg === '-h') opts.help = true
    else opts.unknown = arg
  }
  return opts
}

function modelExists(codexHome, model) {
  const cache = join(codexHome, 'models_cache.json')
  if (!existsSync(cache)) return undefined
  try {
    return readFileSync(cache, 'utf8').includes(`"${model}"`)
  } catch {
    return undefined
  }
}

function runDoctor(codexBin, codexHome) {
  if (!codexBin) return { skipped: true, reason: '找不到 codex 可执行文件（用 --codex-bin 或 CODEX_BIN 指定）' }
  const result = spawnSync(codexBin, ['doctor'], {
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: 'utf8',
    timeout: 120_000,
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const parseOk = /config\.toml parse\s+ok/.test(output)
  const roleWarnings = output
    .split('\n')
    .filter((line) => line.includes('Ignoring malformed agent role definition') && line.includes(ROLE_ID))
  return { ok: parseOk && roleWarnings.length === 0, parseOk, roleWarnings, output }
}

function emptyPlan(state) {
  return {
    ok: false,
    version: state.version,
    codexHome: state.codexHome,
    changed: [],
    skipped: [],
    conflicts: [],
    warnings: [],
    errors: [],
    written: [],
    manifest: manifestPath(state.codexHome),
  }
}

/** 安装 / 更新 / 检查（--check 不写文件）。 */
export function install({
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  check = false,
  dryRun = false,
  doctor = true,
  codexBin,
  root = ROOT,
  env = process.env,
} = {}) {
  const state = desiredState({ codexHome, root })
  const plan = emptyPlan(state)
  const configPath = join(codexHome, 'config.toml')
  if (!existsSync(configPath)) {
    plan.errors.push(`找不到 ${configPath}（先用 Codex 启动一次，或用 --codex-home 指定正确的目录）`)
    return plan
  }

  const bin = findCodexBin({ env, explicit: codexBin })
  plan.codexBin = bin ? { path: bin.path, source: bin.source } : null

  const roles = readRoles(root)
  const spec = roles.roles[ROLE_ID]

  const originalConfig = readFileSync(configPath, 'utf8')
  const originalModel = originalConfig.match(/^model\s*=\s*"([^"]+)"/m)?.[1]
  const originalProvider = originalConfig.match(/^model_provider\s*=\s*"([^"]+)"/m)?.[1]
  const mcpCount = (originalConfig.match(/^\[mcp_servers\.[^\]]+\]/gm) ?? []).length

  const writes = []
  for (const file of state.files) {
    if (!existsSync(file.path)) {
      writes.push({ ...file, existing: undefined, action: 'create' })
      continue
    }
    const current = readFileSync(file.path, 'utf8')
    if (current !== file.content) writes.push({ ...file, existing: current, action: 'update' })
    else plan.skipped.push({ path: file.path, reason: '内容已是最新' })
  }

  const nextConfig = replaceOwnedRegions(originalConfig, AGENT_TABLE, state.agentSection).text
  if (nextConfig !== originalConfig) {
    writes.push({ path: configPath, content: nextConfig, label: 'config agents section', existing: originalConfig, action: 'update' })
  } else plan.skipped.push({ path: configPath, reason: '[agents] 段已是最新' })

  const agentsMdPath = join(codexHome, 'AGENTS.md')
  const originalAgentsMd = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, 'utf8') : ''
  // 损毁标记（不成对的 begin/end）无法界定插件内容范围：保守拒绝写入，
  // 让 AGENTS.md 保持逐字不变，而不是按「最大范围」清理掉后面的用户文字。
  const agentsAnalysis = analyzePluginBlocks(originalAgentsMd)
  if (agentsAnalysis.damagedCount) {
    plan.errors.push(
      `AGENTS.md 有 ${agentsAnalysis.damagedCount} 处不成对的 dsh-multi-agent 标记，无法安全判断规则块范围；为避免吞掉你的文字，安装未修改任何文件。请先修好 begin/end 配对。`,
    )
  } else {
    const nextAgentsMd = upsertPluginBlock(originalAgentsMd, state.block).text
    if (nextAgentsMd !== originalAgentsMd) {
      writes.push({ path: agentsMdPath, content: nextAgentsMd, label: 'AGENTS.md rules block', existing: existsSync(agentsMdPath) ? originalAgentsMd : undefined, action: 'update' })
    } else plan.skipped.push({ path: agentsMdPath, reason: '规则块已是最新' })
  }

  plan.changed = writes.map((item) => ({ path: item.path, label: item.label, action: item.action }))

  const known = modelExists(codexHome, spec.model)
  if (known === false) plan.warnings.push(`模型 ${spec.model} 不在本机模型目录中，角色可能无法启动`)

  if (check) {
    plan.ok = plan.errors.length === 0 && writes.length === 0
    if (writes.length) plan.warnings.push(`有 ${writes.length} 个文件需要更新（运行 node install-codex.mjs）`)
    const manifest = readManifest(codexHome)
    if (!manifest) plan.warnings.push('没有安装记录：重新安装会生成，卸载时可据此恢复被替换的内容')
    return plan
  }

  if (dryRun) {
    plan.ok = plan.errors.length === 0
    return plan
  }

  if (plan.errors.length) {
    plan.ok = false
    return plan
  }

  // 备份 + 写入
  const previousSection = extractOwnedRegion(originalConfig, AGENT_TABLE)
  for (const item of writes) {
    mkdirSync(dirname(item.path), { recursive: true })
    if (item.existing !== undefined) {
      const backup = createBackup(item.path)
      plan.warnings.push(`已备份 ${backup}`)
      item.backup = backup
    }
    writeFileSync(item.path, item.content)
    plan.written.push(item.path)
  }

  // 写后校验：默认模型/提供方未变，MCP 数量不变
  const after = readFileSync(configPath, 'utf8')
  const afterModel = after.match(/^model\s*=\s*"([^"]+)"/m)?.[1]
  const afterProvider = after.match(/^model_provider\s*=\s*"([^"]+)"/m)?.[1]
  const afterMcp = (after.match(/^\[mcp_servers\.[^\]]+\]/gm) ?? []).length
  if (afterModel !== originalModel) plan.errors.push(`默认模型被改动：${originalModel} → ${afterModel}`)
  if (afterProvider !== originalProvider) plan.errors.push('model_provider 被改动')
  if (afterMcp !== mcpCount) plan.errors.push(`MCP server 数量变化：${mcpCount} → ${afterMcp}`)

  if (doctor) {
    const result = runDoctor(bin?.path, codexHome)
    if (result.skipped) plan.warnings.push(`跳过 doctor 校验：${result.reason}`)
    else {
      if (!result.parseOk) plan.errors.push('codex doctor 报告 config.toml 解析失败')
      for (const warning of result.roleWarnings) plan.errors.push(warning.trim())
    }
  }

  // 安装记录：只写路径、哈希与本插件自己的段落正文，不含任何秘密。
  const manifest = readManifest(codexHome) ?? { plugin: 'dsh-codex-bridge' }
  manifest.plugin = 'dsh-codex-bridge'
  manifest.version = state.version
  manifest.bridgeRoot = root
  manifest.codexHome = codexHome
  manifest.files = { ...(manifest.files ?? {}) }
  for (const item of writes) {
    if (item.path === configPath || item.path === agentsMdPath) continue
    const prior = manifest.files[item.path]
    // 重复安装/迁移只更新「安装时哈希」，保留最初的原内容记录（否则卸载会恢复成我们自己的旧文件）
    manifest.files[item.path] = prior
      ? { ...prior, kind: item.label, hash: hashText(item.content) }
      : fileRecord(item.path, item.content, { kind: item.label, existingText: item.existing, backup: item.backup })
  }
  // 角色段的「原内容」引用。
  // 旧段可能含 token/secret：这种情况下绝不把正文存进 manifest，只记录备份文件路径 +
  // 内容哈希，卸载时从备份恢复并核对真实性；备份缺失/内容不符则保留冲突，不丢用户配置。
  const configBackup = writes.find((item) => item.path === configPath)?.backup
  manifest.sections = { ...(manifest.sections ?? {}) }
  const sectionKey = `${configPath}#${AGENT_TABLE}`
  const priorSection = manifest.sections[sectionKey]
  const foreignSection = previousSection && previousSection.trim() !== state.agentSection.trim() ? previousSection : undefined
  const keepPrior = Boolean(
    priorSection &&
      (priorSection.previous != null ||
        priorSection.previousBackup ||
        priorSection.previousHash ||
        priorSection.previousSecret ||
        priorSection.previousFound),
  )
  const sectionRecord = { installed: state.agentSection.trim(), previous: null, previousFound: false }
  if (keepPrior) {
    // 重复安装 / 目录迁移：只更新「当前安装内容」，保留最初的原内容引用
    sectionRecord.previous = priorSection.previous ?? null
    sectionRecord.previousBackup = priorSection.previousBackup ?? null
    sectionRecord.previousHash = priorSection.previousHash ?? null
    sectionRecord.previousSecret = Boolean(priorSection.previousSecret)
    sectionRecord.previousFound = true
  } else if (foreignSection && !isOwnAgentSection(foreignSection)) {
    const secret = looksSecretText(foreignSection)
    sectionRecord.previousFound = true
    sectionRecord.previousSecret = secret
    sectionRecord.previousHash = hashText(foreignSection)
    // 备份里是整个 config.toml（用户自己的文件），可作为恢复引用；秘密正文不入库
    sectionRecord.previousBackup = configBackup ?? null
    sectionRecord.previous = secret ? null : foreignSection
  }
  manifest.sections[sectionKey] = sectionRecord
  manifest.agentsBlock = { hash: hashText(state.block) }
  writeManifest(codexHome, manifest)

  plan.ok = plan.errors.length === 0
  return plan
}

/** 卸载：只释放本插件拥有的内容，用户后改的内容保留并报告冲突。 */
export function uninstall({ codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), root = ROOT } = {}) {
  const state = desiredState({ codexHome, root })
  const plan = emptyPlan(state)
  plan.ok = true
  const manifest = readManifest(codexHome)
  const configPath = join(codexHome, 'config.toml')

  if (!manifest) {
    const rulesFile = join(codexHome, 'AGENTS.md')
    const hasRules = existsSync(rulesFile) && analyzePluginBlocks(readFileSync(rulesFile, 'utf8')).blocks.length > 0
    if (state.files.some((file) => existsSync(file.path)) || hasRules) {
      plan.conflicts.push({ path: codexHome, reason: '安装记录缺失或无法读取，无法确认原内容；本次保留所有文件，请从备份核对后再处理' })
      plan.ok = false
    } else plan.warnings.push('没有找到本插件的安装内容，无需卸载')
    return plan
  }

  // 1. 整文件（角色 TOML、两个 Skill）
  for (const file of state.files) {
    const entry = manifest.files?.[file.path]
    if (!entry) {
      plan.skipped.push({ path: file.path, reason: '没有此文件的安装记录，保留现有内容' })
      continue
    }
    const result = releaseFile(file.path, entry)
    if (result.action === 'missing') {
      plan.skipped.push({ path: file.path, reason: '不存在，跳过' })
    } else if (result.action === 'conflict') {
      plan.conflicts.push({ path: file.path, reason: result.detail })
    } else {
      plan.written.push(file.path)
      plan.changed.push({ path: file.path, label: file.label, action: result.action === 'restored' ? `restored ${result.detail}` : 'removed' })
      if (result.action === 'removed') pruneEmptyDir(dirname(file.path))
    }
  }

  // 2. config.toml 里的角色表
  if (existsSync(configPath)) {
    const original = readFileSync(configPath, 'utf8')
    const region = extractOwnedRegion(original, AGENT_TABLE)
    const sectionRecord = manifest?.sections?.[`${configPath}#${AGENT_TABLE}`]
    const installed = sectionRecord?.installed ?? state.agentSection.trim()
    const matchesInstalled = region !== undefined && region.trim() === installed
    if (region === undefined) {
      plan.skipped.push({ path: configPath, reason: '没有本插件的角色段' })
    } else if (!sectionRecord) {
      // 没有安装记录、内容也不是当前渲染结果：不能证明归属，保留用户配置
      plan.skipped.push({ path: configPath, reason: `没有安装记录，[${AGENT_TABLE}] 不是本插件安装的，保留` })
    } else if (sectionRecord && !matchesInstalled) {
      plan.conflicts.push({ path: configPath, reason: `[${AGENT_TABLE}] 安装后被修改过，保留你的内容` })
    } else {
      // 归属已确认。恢复原角色段：优先用记录里的正文；若正文因含秘密未入库，
      // 则从记录的原文件备份里取回并核对哈希；备份缺失/不符时保留冲突，绝不删用户配置。
      let restored = typeof sectionRecord?.previous === 'string' ? sectionRecord.previous : undefined
      let restoreProblem
      if (restored === undefined && sectionRecord?.previousFound) {
        const backupPath = sectionRecord.previousBackup
        if (!backupPath) {
          restoreProblem = `安装记录里没有原 [${AGENT_TABLE}] 段的备份引用，保留当前内容（可能含你的凭据配置）`
        } else if (!existsSync(backupPath)) {
          restoreProblem = `原 [${AGENT_TABLE}] 段的备份已丢失：${backupPath}，保留当前内容`
        } else {
          const previous = extractOwnedRegion(readFileSync(backupPath, 'utf8'), AGENT_TABLE)
          if (!previous) {
            restoreProblem = `备份中找不到原 [${AGENT_TABLE}] 段：${backupPath}，保留当前内容`
          } else if (sectionRecord.previousHash && hashText(previous) !== sectionRecord.previousHash) {
            restoreProblem = `备份中的原 [${AGENT_TABLE}] 段与安装记录不一致：${backupPath}，保留当前内容`
          } else {
            restored = previous
          }
        }
      }

      if (restoreProblem) {
        plan.conflicts.push({ path: configPath, reason: restoreProblem })
      } else {
        const backup = createBackup(configPath)
        plan.warnings.push(`已备份 ${backup}`)
        const next = restored
          ? replaceOwnedRegions(original, AGENT_TABLE, restored).text
          : removeOwnedRegions(original, AGENT_TABLE).text
        writeFileSync(configPath, next)
        plan.written.push(configPath)
        plan.changed.push({
          path: configPath,
          label: `config ${AGENT_TABLE}`,
          action: restored ? 'restored previous section' : 'removed section',
        })
      }
    }
  } else {
    plan.skipped.push({ path: configPath, reason: 'config.toml 不存在' })
  }

  // 3. AGENTS.md 规则块：只清理「与安装记录哈希一致」的完整块。
  //    标记损毁 → 保守保留；用户改过标记内正文 → 冲突保留，不无条件 strip。
  const agentsMdPath = join(codexHome, 'AGENTS.md')
  if (existsSync(agentsMdPath)) {
    const original = readFileSync(agentsMdPath, 'utf8')
    const analysis = analyzePluginBlocks(original)
    if (!analysis.blocks.length) {
      plan.skipped.push({ path: agentsMdPath, reason: '没有规则块' })
    } else if (analysis.damagedCount) {
      plan.conflicts.push({
        path: agentsMdPath,
        reason: `有 ${analysis.damagedCount} 处不成对的规则块标记，无法安全判断插件内容范围；为避免吞掉用户文字，文件保持原样`,
      })
    } else {
      const expectedHash = manifest.agentsBlock?.hash
      const foreign = analysis.complete.filter((item) => !expectedHash || hashText(blockText(original, item)) !== expectedHash)
      if (foreign.length) {
        plan.conflicts.push({
          path: agentsMdPath,
          reason: `规则块内容与${manifest?.agentsBlock?.hash ? '安装记录' : '当前渲染结果'}不一致（安装后被编辑过），保留你的内容`,
        })
      } else {
        const stripped = stripPluginBlocks(original)
        const backup = createBackup(agentsMdPath)
        plan.warnings.push(`已备份 ${backup}`)
        writeFileSync(agentsMdPath, stripped.text)
        plan.written.push(agentsMdPath)
        plan.changed.push({ path: agentsMdPath, label: 'AGENTS.md rules block', action: `removed ${stripped.removed} block(s)` })
      }
    }
  }

  // 4. 安装记录：没有遗留归属项就删掉
  const conflicted = new Set(plan.conflicts.map((item) => item.path))
  for (const file of state.files) if (!conflicted.has(file.path)) delete manifest.files?.[file.path]
  if (!conflicted.has(configPath)) delete manifest.sections?.[`${configPath}#${AGENT_TABLE}`]
  if (!conflicted.has(agentsMdPath)) delete manifest.agentsBlock
  const remaining = manifest.mcp || Object.keys(manifest.files ?? {}).length || Object.keys(manifest.sections ?? {}).length || manifest.agentsBlock
  if (remaining) writeManifest(codexHome, manifest)
  else removeManifest(codexHome)

  plan.ok = plan.conflicts.length === 0 && plan.errors.length === 0
  return plan
}

/* ------------------------------------------------------------------ CLI */

const HELP = `用法: node install-codex.mjs [--check] [--dry-run] [--uninstall]
                        [--codex-home <dir>] [--codex-bin <path>] [--no-doctor]

  --check      只读检查；未安装 / 需要更新 / 出错时退出码 1
  --dry-run    预览将要改动的文件，不写任何东西
  --uninstall  只移除本插件安装的角色 / 技能 / 规则块，保留其他配置
  --codex-home 指定 Codex 主目录（默认 $CODEX_HOME 或 ~/.codex）
  --codex-bin  显式指定 codex 可执行文件（默认 PATH / 应用目录发现）
  --no-doctor  跳过 codex doctor 校验
`

function report(plan, opts) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  if (opts.check) {
    for (const item of plan.changed) process.stderr.write(`需要更新: ${item.path}\n`)
    for (const item of plan.skipped) process.stderr.write(`已最新: ${item.path}\n`)
    for (const error of plan.errors) process.stderr.write(`错误: ${error}\n`)
    for (const warning of plan.warnings) process.stderr.write(`提示: ${warning}\n`)
    process.exit(plan.ok ? 0 : 1)
  }
  if (opts.uninstall) {
    for (const conflict of plan.conflicts) process.stderr.write(`冲突（已保留）: ${conflict.path} — ${conflict.reason}\n`)
    for (const error of plan.errors) process.stderr.write(`错误: ${error}\n`)
    for (const change of plan.changed) process.stderr.write(`已处理: ${change.path}（${change.action}）\n`)
    if (!plan.changed.length && !plan.conflicts.length) process.stderr.write('没有需要卸载的本插件内容\n')
    process.exit(plan.ok ? 0 : 1)
  }
  if (opts.dryRun) {
    for (const item of plan.changed) process.stderr.write(`将更新: ${item.path}（${item.action}）\n`)
    for (const error of plan.errors) process.stderr.write(`错误: ${error}\n`)
    process.exit(plan.ok ? 0 : 1)
  }
  if (plan.errors.length) {
    for (const error of plan.errors) process.stderr.write(`错误: ${error}\n`)
    process.exit(1)
  }
  process.stderr.write(plan.written.length ? `已安装 ${plan.written.length} 个文件\n` : '已是最新，无需改动\n')
}

/**
 * 判断本文件是否被当作主程序直接执行。
 *
 * 不能用 `import.meta.url === pathToFileURL(resolve(argv[1])).href` 直接比较：
 * macOS 上 `/var/...` 与真实路径 `/private/var/...`、或把源码目录做成符号链接时，
 * 两者字符串不同，会让入口静默不执行（dry-run 退出码 0 但 stdout 为空）。
 * 这里统一解析成真实文件路径（realpath）后再比较；命令行参数保持原样。
 */
export function isMainModule(invoked = process.argv[1], selfUrl = import.meta.url) {
  if (!invoked) return false
  try {
    return realpathSync(fileURLToPath(selfUrl)) === realpathSync(resolve(invoked))
  } catch {
    return false
  }
}

const isMain = isMainModule()
if (isMain) {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  if (opts.unknown) {
    process.stderr.write(`未知参数: ${opts.unknown}\n\n${HELP}`)
    process.exit(64)
  }
  const plan = opts.uninstall
    ? uninstall({ codexHome: opts.codexHome, root: ROOT })
    : install({ codexHome: opts.codexHome, check: opts.check, dryRun: opts.dryRun, doctor: opts.doctor, codexBin: opts.codexBin, root: ROOT })
  report(plan, opts)
}
