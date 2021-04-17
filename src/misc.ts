import { LiveServerParams } from '.'
import fs from 'fs'
import { message } from './msg'
import path from 'path'

// just a fallback for removing http-errors dependency
export const createError = (code: number, msg: string = 'unknown', _nothing?: any) => {
  if (code !== 404) message.log(`ERROR: ${code} ${msg}`)
  return { message: msg, code, status: code, statusCode: code, name: code }
}

export const escape = html => {
  return String(html)
    .replace(/&(?!\w+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export const removeLeadingSlash = (str: string): string => {
  return str.replace(/^\/+/g, '')
}

export const removeTrailingSlash = (str: string) => {
  return str.replace(/\/+$/g, '')
}

/**
 * Get and parse the configFile.
 * @param configFile Absolute path of configFile, or true, or false.
 * @param workspace Absolute path to the current workspace.
 * @returns LiveServerParams
 */
export const getConfigFile = (configFile: string | boolean = true, workspace?: string): LiveServerParams => {
  let options: LiveServerParams = {
    host: process.env.IP,
    port: process.env.PORT ? parseInt(process.env.PORT) : 5555,
    open: true,
    mount: [],
    proxy: [],
    middleware: [],
    logLevel: 1
  }

  if (configFile === false) return options

  const dirs: string[] = []
  const files = [
    '.fiveserverrc',
    '.fiveserverrc.json',
    '.fiveserverrc.js',
    '.fiveserverrc.cjs',
    'fiveserver.config.js',
    'fiveserver.config.cjs',
    '.live-server.json'
  ]

  if (typeof configFile === 'string') {
    // TODO: Add support for this
    files.unshift(configFile)
  }

  if (workspace) dirs.push(workspace)

  dirs.push(path.resolve())

  const homeDir = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME']
  if (homeDir) dirs.push(homeDir)

  dirs.push(process.cwd())

  const isJSReg = /\.c?js$/

  loop: for (const d of dirs) {
    for (const f of files) {
      const configPath = path.join(d, f)
      if (fs.existsSync(configPath)) {
        const isJS = isJSReg.test(path.extname(configPath))

        if (isJS) {
          try {
            delete require.cache[configPath]
            const config = require(configPath)

            if (Object.keys(config).length === 0) {
              message.warn(`Config file "${f}" is empty or has issues`)
            }

            options = { ...options, ...config }
          } catch (err) {
            message.error(err.message, f, false)
          }
        } else {
          const config = fs.readFileSync(configPath, 'utf8')
          try {
            options = { ...options, ...JSON.parse(config) }
          } catch (err) {
            message.error(err.message, f, false)
          }
        }

        if (options.ignorePattern) options.ignorePattern = new RegExp(options.ignorePattern)

        break loop
      }
    }
  }

  // some small adjustments
  if (options.root) options.root = options.root.replace(/^\/+/, '')
  if (options.open === 'true') options.open = true
  if (options.open === 'false') options.open = false
  if (options.https === 'true') options.https = true

  return options
}
