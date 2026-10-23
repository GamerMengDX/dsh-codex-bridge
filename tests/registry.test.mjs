import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  SessionBindingError,
  canonicalCwd,
  ensureSession,
  findEntry,
  hashLabel,
  legacySessionIdFor,
  loadRegistry,
  registryPath,
  saveRegistry,
  sessionIdFor,
  slugLabel,
} from '../lib/registry.mjs'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-registry-'))
}

test('易混标签生成不同 ID，且同一标签稳定', () => {
  const ids = ['proj_a', 'proj a', 'proj-a'].map((label) => sessionIdFor(label, 'analyze'))
  assert.equal(new Set(ids).size, 3)
  assert.equal(sessionIdFor('proj_a', 'analyze'), sessionIdFor('proj_a', 'analyze'))
  assert.equal(hashLabel('proj_a').length, 8)
})

test('slug 保留可读前缀与中文', () => {
  assert.equal(slugLabel('项目 A/x'), '项目-a-x')
  assert.match(sessionIdFor('项目 A/x', 'edit'), /^bridge-edit-项目-a-x-[0-9a-f]{8}$/)
})

test('首次创建、再次复用、cwd 绑定校验', () => {
  const root = tempRoot()
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-cwd-'))
  const first = ensureSession(root, { label: 'proj', mode: 'analyze', cwd })
  assert.equal(first.created, true)

  const second = ensureSession(root, { label: 'proj', mode: 'analyze', cwd })
  assert.equal(second.created, false)
  assert.equal(second.entry.id, first.entry.id)

  const other = mkdtempSync(join(tmpdir(), 'dsh-cwd-'))
  assert.throws(
    () => ensureSession(root, { label: 'proj', mode: 'analyze', cwd: other }),
    SessionBindingError,
  )
})

test('符号链接与相对路径被规范化为同一真实目录', () => {
  const root = tempRoot()
  const real = mkdtempSync(join(tmpdir(), 'dsh-real-'))
  const link = join(tempRoot(), 'link')
  // 用 fs.symlinkSync 需要 import；这里改用 canonicalCwd 对同一路径的两种写法
  assert.equal(canonicalCwd(real), canonicalCwd(`${real}/.`))
  const entry = ensureSession(root, { label: 'x', mode: 'analyze', cwd: `${real}/.` })
  assert.equal(entry.entry.cwd, canonicalCwd(real))
  void link
})

test('兼容旧版无哈希 ID，不丢历史', () => {
  const root = tempRoot()
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-cwd-'))
  const legacyId = legacySessionIdFor('old-proj', 'analyze')
  mkdirSync(root, { recursive: true })
  writeFileSync(
    registryPath(root),
    JSON.stringify({ sessions: { [legacyId]: { id: legacyId, label: 'old-proj', mode: 'analyze', cwd } } }),
  )

  const { entry, idMigrated } = ensureSession(root, { label: 'old-proj', mode: 'analyze', cwd })
  assert.equal(entry.id, legacyId)
  assert.equal(idMigrated, true)
})

test('注册表原子写入：版本、权限、无临时文件残留', () => {
  const root = tempRoot()
  saveRegistry(root, { sessions: { a: { id: 'a' } } })
  const file = registryPath(root)
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(parsed.version, 2)
  assert.ok(parsed.sessions.a)

  const mode = statSync(file).mode & 0o777
  assert.equal(mode, 0o600)

  const leftovers = readdirSync(root).filter((name) => name.includes('.tmp-') || name.endsWith('.lock'))
  assert.deepEqual(leftovers, [])
})

test('注册表损坏时备份而不是静默清空', () => {
  const root = tempRoot()
  mkdirSync(root, { recursive: true })
  writeFileSync(registryPath(root), '{ not json')
  const registry = loadRegistry(root)
  assert.deepEqual(registry.sessions, {})
  assert.ok(registry.corruptBackup)
  const backups = readdirSync(root).filter((name) => name.includes('.corrupt-'))
  assert.equal(backups.length, 1)
})

test('findEntry 同时识别新 ID 与旧条目', () => {
  const registry = {
    sessions: {
      'bridge-analyze-x-12345678': { id: 'bridge-analyze-x-12345678', label: 'x', mode: 'analyze' },
      'bridge-edit-y': { id: 'bridge-edit-y', label: 'y', mode: 'edit' },
    },
  }
  assert.equal(findEntry(registry, { label: 'x', mode: 'analyze' }).id, 'bridge-analyze-x-12345678')
  assert.equal(findEntry(registry, { label: 'y', mode: 'edit' }).id, 'bridge-edit-y')
  assert.equal(findEntry(registry, { label: 'nope', mode: 'edit' }), undefined)
})
