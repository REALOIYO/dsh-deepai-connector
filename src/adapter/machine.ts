/**
 * 机器指纹。
 *
 * 上游按 `X-DeepAI-Code-Machine` **每天只发一次**免费 Theos，值必须是
 * `sha256(原始机器 UUID 小写)`。原始值绝不上传，也不落盘。
 *
 * Windows 取 `(Get-CimInstance Win32_ComputerSystemProduct).UUID`，
 * 固件占位 UUID 时回落到注册表 `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`；
 * macOS 取 `ioreg` 的 `IOPlatformUUID`；Linux 取 `/sys/class/dmi/id/product_uuid`
 * 其次 `/etc/machine-id`。
 *
 * 读不到时**返回空串**，调用方据此不发该头（而不是发一个空值）——
 * 空值会被上游判成 `machine_required`。
 *
 * @module src/adapter/machine.ts
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 固件占位 UUID，出现即说明厂商没填真值。 */
const PLACEHOLDER_UUIDS = new Set([
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '03000200-0400-0500-0006-000700080009',
])

/**
 * 把原始机器标识转成上游要求的 sha256 十六进制。
 *
 * 空串返回空串：调用方据此不发该请求头。
 */
export function machineFingerprint(raw: string): string {
  const value = raw.trim().toLowerCase()
  if (value === '') return ''
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** 判断一个 UUID 是否是固件占位值。 */
export function isPlaceholderUuid(raw: string): boolean {
  return PLACEHOLDER_UUIDS.has(raw.trim().toLowerCase())
}

/** 读 Windows 的机器 UUID。任何一步失败都返回空串。 */
async function windowsRawUuid(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-CimInstance Win32_ComputerSystemProduct).UUID',
      ],
      { timeout: 8000, windowsHide: true },
    )
    const uuid = stdout.trim()
    if (uuid !== '' && !isPlaceholderUuid(uuid)) return uuid
  } catch {
    // 继续走注册表回落
  }

  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { timeout: 8000, windowsHide: true },
    )
    const match = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(stdout)
    if (match?.[1] !== undefined) return match[1].trim()
  } catch {
    // 读不到就是读不到
  }
  return ''
}

/** 读 macOS 的 IOPlatformUUID。 */
async function darwinRawUuid(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      timeout: 8000,
    })
    const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)
    return match?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

/** 读 Linux 的 product_uuid，其次 machine-id。 */
async function linuxRawUuid(): Promise<string> {
  for (const path of ['/sys/class/dmi/id/product_uuid', '/etc/machine-id']) {
    try {
      const raw = (await readFile(path, 'utf8')).trim()
      if (raw !== '' && !isPlaceholderUuid(raw)) return raw
    } catch {
      // 换下一个候选
    }
  }
  return ''
}

/**
 * 探测本机机器指纹。
 *
 * `DEEPAI_MACHINE_ID` 可显式覆盖（容器 / 无 SMBIOS 环境用），
 * 覆盖值是**原始 UUID** 而不是指纹本身，函数会照常做 sha256。
 *
 * 只读一次，结果由调用方缓存。
 */
export async function detectMachineFingerprint(env = process.env): Promise<string> {
  const override = (env.DEEPAI_MACHINE_ID ?? '').trim()
  if (override !== '') return machineFingerprint(override)

  let raw = ''
  switch (process.platform) {
    case 'win32':
      raw = await windowsRawUuid()
      break
    case 'darwin':
      raw = await darwinRawUuid()
      break
    default:
      raw = await linuxRawUuid()
  }
  return machineFingerprint(raw)
}

/** 生成一个随机 UUID（v4），用于测试或独立账号隔离。 */
export function randomUuid(): string {
  // crypto.randomUUID 自 Node 19 起是全局的，且保证 v4 变体位。
  return crypto.randomUUID()
}
