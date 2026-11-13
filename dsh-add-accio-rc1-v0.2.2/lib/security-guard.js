/**
 * Alibaba SecurityGuard request signing.
 *
 * Accio's gateway rejects LLM calls that are not signed by the SecurityGuard
 * SDK, so this loads Accio's own `security_guard.node` and asks it for the
 * `pctb-x-*` header set. The addon is a plain Node native addon and loads with
 * `isStub: false` under ordinary Node — no Electron host and no traffic
 * interception are involved.
 *
 * Two details are load-bearing and easy to get wrong:
 *
 *   1. `getSecurityFactorsForWeb` takes a JSON **string**, and on Windows the
 *      object is `{ appkey, urlInput }` — not the `{ appkey, api, data }` shape
 *      the non-Windows branch uses.
 *   2. The URL must be the one actually fetched, **including the `?sg_k=`
 *      query**. Accio builds `${base}/generateContent?sg_k=…`, puts that full
 *      URL in the request object, and signs that object — so signing the bare
 *      path produces a signature that does not cover the request.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** SecurityGuard app key per platform, as Accio's own bundle hardcodes it. */
const APPKEY = process.platform === 'darwin' ? '35337600' : '35336201'

/**
 * Candidate locations of `security_guard.node`.
 *
 * Accio keeps it under `resources/app.asar.unpacked`, because a native addon
 * cannot live inside an asar archive. The search walks upward from the running
 * process so a DSH installed anywhere can find an Accio installed anywhere,
 * and `resourcesPath` (Electron) is consulted first when present.
 */
/**
 * The install directory Windows recorded for Accio.
 *
 * The user picks where Accio installs (this machine has `D:\ProgramFiles\Accio`,
 * which no default list would guess), so the uninstall registry key is the
 * authoritative source. The `UninstallString` is parsed rather than
 * `InstallLocation`, because this installer leaves `InstallLocation` empty.
 *
 * Read-only, best-effort: any failure returns undefined and the caller falls
 * back to the well-known paths.
 */
export function installDirFromRegistry() {
  if (process.platform !== 'win32') return undefined
  const keys = [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  try {
    // One reg.exe call per hive, asking for the values of every subkey whose
    // display name matches; parsing output is cheaper than a native dependency.
    for (const key of keys) {
      let out
      try {
        out = execFileSync('reg.exe', ['query', key, '/s', '/f', 'Accio', '/d'], {
          encoding: 'utf8', timeout: 10_000, windowsHide: true,
        })
      } catch {
        continue
      }
      for (const line of out.split(/\r?\n/)) {
        const m = /UninstallString\s+REG_SZ\s+(.+)$/i.exec(line.trim())
        if (m === null) continue
        // The value is a quoted executable followed by arguments, e.g.
        //   "D:\ProgramFiles\Accio\Uninstall Accio.exe" /currentuser
        // so take the quoted path when present, and only then drop the filename.
        const value = m[1].trim()
        const quoted = /^"([^"]+)"/.exec(value)
        const exePath = quoted !== null ? quoted[1] : value.split(/\s+/)[0]
        const dir = exePath.replace(/[\\/][^\\/]+$/, '')
        if (dir !== '' && existsSync(dir)) return dir
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Candidate `resources` directories under one Accio install root.
 *
 * Accio 0.38+ ships each release in `<root>/versions/<version>/resources/…`
 * and leaves `<root>/resources` empty. Older builds keep the addon directly
 * under `<root>/resources`. Probe both, newest version first, so an Accio
 * upgrade no longer breaks request signing (and no junction or env override
 * is needed to bridge the two layouts).
 */
function resourcesRoots(root) {
  const out = [join(root, 'resources')]
  const versionsDir = join(root, 'versions')
  try {
    if (!existsSync(versionsDir)) return out
    const versions = readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const version of versions) out.push(join(versionsDir, version, 'resources'))
  } catch {
    // No versions directory, or one this process cannot read: the flat layout
    // above is still a valid candidate.
  }
  return out
}

export function securityGuardCandidates() {
  const roots = []
  const add = (root) => {
    if (typeof root === 'string' && root !== '') roots.push(root)
  }

  // An explicit override wins over every guess.
  add(process.env.ACCIO_SECURITY_GUARD_DIR)

  // Electron's own resources dir, when the host happens to be an Electron app.
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    add(join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@phoenix-common', 'security-guard'))
  }

  // Where Windows says Accio is installed. Checked before the default paths
  // because the user chooses the install location.
  const installRoots = []
  const installed = installDirFromRegistry()
  if (installed !== undefined) installRoots.push(installed)

  // Well-known locations, for a machine where the registry read failed.
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (typeof base === 'string' && base !== '') installRoots.push(join(base, 'Accio'))
  }
  if (typeof process.env.LOCALAPPDATA === 'string' && process.env.LOCALAPPDATA !== '') {
    installRoots.push(join(process.env.LOCALAPPDATA, 'Programs', 'Accio'))
    installRoots.push(join(process.env.LOCALAPPDATA, 'Accio'))
  }

  // Both the flat layout and every versioned layout, newest release first.
  for (const root of installRoots) {
    for (const resources of resourcesRoots(root)) {
      add(join(resources, 'app.asar.unpacked', 'node_modules', '@phoenix-common', 'security-guard'))
    }
  }

  // Finally: a sibling `Accio` directory next to the running executable's
  // parents, covering two apps installed side by side under one folder.
  let dir = process.execPath
  for (let i = 0; i < 4 && typeof dir === 'string'; i += 1) {
    const parent = join(dir, '..')
    for (const resources of resourcesRoots(join(parent, 'Accio'))) {
      add(join(resources, 'app.asar.unpacked', 'node_modules', '@phoenix-common', 'security-guard'))
    }
    const next = join(parent, '..')
    if (next === dir) break
    dir = next
  }

  const platformDir = `${process.platform}-${process.arch}`
  const paths = []
  for (const root of roots) {
    paths.push(join(root, 'prebuild', platformDir, 'security_guard.node'))
    paths.push(join(root, 'prebuild', 'nodejs', platformDir, 'security_guard.node'))
    paths.push(join(root, 'build', 'Release', 'security_guard.node'))
    // The directory itself, when the override points straight at the addon dir.
    paths.push(join(root, 'security_guard.node'))
  }
  return [...new Set(paths)]
}

let cached = null

/**
 * Load the SecurityGuard addon.
 *
 * @param explicit - an explicit `security_guard.node` path, or its directory.
 * @returns the addon, or undefined when no candidate loads. Failure is returned
 *   rather than thrown because signing is advisory at discovery time: the card
 *   wants to report "signing unavailable" instead of failing to load.
 */
export function loadSecurityGuard(explicit) {
  if (cached !== null) return cached
  const candidates = []
  if (typeof explicit === 'string' && explicit !== '') {
    candidates.push(explicit.endsWith('.node') ? explicit : join(explicit, 'security_guard.node'))
  }
  candidates.push(...securityGuardCandidates())

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const require = createRequire(pathToFileURL(candidate).href)
      const addon = require(candidate)
      if (addon && addon.isStub !== true && typeof addon.getSecurityFactorsForWeb === 'function') {
        cached = { addon, path: candidate }
        return cached
      }
    } catch {
      // A candidate that exists but cannot load (wrong arch, missing VC runtime)
      // is not fatal: keep probing the rest.
    }
  }
  cached = undefined
  return cached
}

/** Forget the cached addon, so a re-configure can pick up a new path. */
export function resetSecurityGuard() {
  cached = null
}

/**
 * Build the signed header set for one request.
 *
 * @param fullUrl - the absolute URL **including** its query string.
 * @param explicitPath - optional explicit addon path or directory.
 * @returns the headers to merge into the outgoing request.
 * @throws when the addon is unavailable or refuses to sign, with the addon's own
 *   error code preserved so the failure is diagnosable rather than opaque.
 */
export function securityHeaders(fullUrl, explicitPath) {
  const loaded = loadSecurityGuard(explicitPath)
  if (loaded === undefined) {
    throw new Error('accio: security_guard.node not found; set ACCIO_SECURITY_GUARD_DIR to Accio\'s @phoenix-common/security-guard directory')
  }
  const out = loaded.addon.getSecurityFactorsForWeb(JSON.stringify({ appkey: APPKEY, urlInput: fullUrl }))
  const text = typeof out === 'string' ? out : String(out)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`accio: security_guard returned non-JSON headers: ${text.slice(0, 200)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('accio: security_guard returned an unexpected header payload')
  }
  // The addon can return an error envelope instead of headers; surface it.
  if (parsed.errorCode !== undefined && parsed.errorCode !== 0 && parsed.errorCode !== 1) {
    throw new Error(`accio: security_guard signing failed with errorCode=${parsed.errorCode}`)
  }
  return parsed
}
