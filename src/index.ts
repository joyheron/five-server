/* eslint-disable sort-imports */

/**
 * @copyright
 * Copyright (c) 2012 Tapio Vierros (https://github.com/tapio)
 * Copyright (c) 2021 Yannick Deubel (https://github.com/yandeu)
 *
 * @license {@link https://github.com/yandeu/five-server/blob/main/LICENSE LICENSE}
 *
 * @description
 * forked from live-server@1.2.1 (https://github.com/tapio/live-server)
 * previously licensed under MIT (https://github.com/tapio/live-server#license)
 */

import chokidar from 'chokidar'
import { donate, getConfigFile, removeLeadingSlash } from './misc'
import http from 'http'
import https from 'https'
import os from 'os'
import path from 'path'

// MOD: Replaced "connect" by "express"
// const connect = require('connect')
import express from 'express'

// MOD: Replaced "faye-websocket" by "ws"
// const WebSocket: any = require('faye-websocket')
import WebSocket from 'ws' // eslint-disable-line sort-imports

// some imports
import { Colors, colors } from './colors'
import { ProxyMiddlewareOptions } from './middleware/proxy'
import { Certificate, LiveServerParams } from './types'
import { getCertificate } from './utils/getCertificate'
import { getNetworkAddress } from './utils/getNetworkAddress'
import { openBrowser } from './openBrowser'

// execute php
import { ExecPHP } from './utils/execPHP'
import { INJECTED_CODE } from './public'
import { message } from './msg'
const PHP = new ExecPHP()

// for hot body injections
import WorkerPool from './workers/workerPool'
import type { Report } from 'html-validate'

// middleware
import explorer from './middleware/explorer' // const serveIndex = require('serve-index')
import { findIndex } from './middleware/findIndex'
import { injectCode } from './middleware/injectCode'
import { fallbackFile } from './middleware/fallbackFile'
import { preview } from './middleware/preview'
import { ignoreExtension } from './middleware/ignoreExtension'
import { favicon } from './middleware/favicon'
import { notFound } from './middleware/notFound'
import { cache as cacheMiddleware } from './middleware/cache'

export { LiveServerParams }

// extend WebSocket interface
interface ExtendedWebSocket extends WebSocket {
  sendWithDelay: (data: any, cb?: ((err?: Error | undefined) => void) | undefined) => void
  file: string
  ip: string
  color: Colors
}

export default class LiveServer {
  public httpServer!: http.Server
  public watcher!: chokidar.FSWatcher
  public logLevel = 1
  public injectBody = false

  /** inject stript to any file */
  public servePreview = true

  private _parseBody: WorkerPool | undefined
  private _parseBody_IsValidHtml = true
  private _parseBody_updateBody(
    fileName: string,
    text: string,
    shouldHighlight: boolean = false,
    cursorPosition: { line: number; character: number } = { line: 0, character: 0 }
  ): void {
    this._parseBody?.postMessage(
      JSON.stringify({
        fileName,
        text,
        shouldHighlight,
        cursorPosition
      })
    )
  }

  public get parseBody() {
    if (this._parseBody) return { workers: this._parseBody, updateBody: this._parseBody_updateBody.bind(this) }

    this._parseBody = new WorkerPool('./parseBody.js', {
      worker: 2,
      rateLimit: 50,
      logLevel: this.logLevel,
      init: { phpExecPath: PHP.path, phpIniPath: PHP.ini }
    })

    this._parseBody.on('message', d => {
      const data = JSON.parse(d)

      if (data.ignore) return
      if (data.time) console.log('TIME', data.time)

      const { body, report, fileName } = data as {
        report: Report
        body: string
        fileName: string
      }

      if (report.valid) {
        this.updateBody(fileName, body)

        if (!this._parseBody_IsValidHtml) {
          this._parseBody_IsValidHtml = true
          this?.sendMessage(fileName, 'HIDE_MESSAGES')
        }
      } else {
        this._parseBody_IsValidHtml = false
        if (report.results.length > 0 && report.results[0].messages.length > 0) {
          const errors = report.results[0].messages.map(m => `${m.message}\n  at line: ${m.line}`)

          this.sendMessage(fileName, errors)
        }
      }
    })

    return { workers: this._parseBody, updateBody: this._parseBody_updateBody.bind(this) }
  }

  private colors: Colors[] = ['magenta', 'cyan', 'blue', 'green', 'yellow', 'red']
  private colorIndex = -1
  private newColor = () => {
    this.colorIndex++
    return this.colors[this.colorIndex % this.colors.length]
  }

  // WebSocket clients
  public clients: ExtendedWebSocket[] = []

  // http sockets
  public sockets: Set<any> = new Set()
  public ipColors: Map<string, Colors> = new Map()

  private _openURL!: string
  private _protocol!: 'http' | 'https'

  public get openURL() {
    return this._openURL
  }

  public get protocol() {
    return this._protocol
  }

  public get isRunning() {
    return !!this.httpServer?.listening
  }

  /** Start five-server */
  public async start(options: LiveServerParams = {}): Promise<void> {
    if (!options._cli) {
      const opts = getConfigFile(options.configFile, options.workspace)
      options = { ...opts, ...options }
    }

    const {
      browser = 'default',
      cache = true,
      cors = false,
      file,
      htpasswd = null,
      https: _https = null,
      injectBody = false,
      injectCss = true,
      logLevel = 1,
      middleware = [],
      mount = {},
      php,
      phpIni,
      port = 5500,
      proxy = {},
      remoteLogs = false,
      useLocalIp = false,
      wait = 100,
      withExtension = 'unset',
      workspace
    } = options

    PHP.path = php
    PHP.ini = phpIni

    this.logLevel = message.logLevel = logLevel

    let host = options.host || '0.0.0.0' // 'localhost'
    if (useLocalIp && host === 'localhost') host = '0.0.0.0'

    this.injectBody = injectBody

    let _watch = options.watch
    if (_watch === true) _watch = ['.']

    if (_watch === false) _watch = false
    else if (_watch && !Array.isArray(_watch)) _watch = [_watch]

    if (typeof _watch === 'undefined') _watch = ['.']

    // tmp
    const _tmp = options.root || process.cwd()
    /** CWD (absolute path) */
    const cwd = workspace ? workspace : process.cwd()
    /** root (absolute path) */
    const root = workspace ? path.join(workspace, options.root ? options.root : '') : path.resolve(_tmp)
    /** file, dir, glob, or array => passed to chokidar.watch() (relative path to CWD) */
    const watch = _watch

    // console.log('cwd', cwd)
    // console.log('root', root)
    // console.log('watch', watch)

    /** the path(s) to be opened in the browser */
    let openPath = options.open
    if (typeof openPath === 'string') openPath = removeLeadingSlash(openPath)
    else if (Array.isArray(openPath)) openPath.map(o => removeLeadingSlash(o))
    else if (openPath === undefined || openPath === true) openPath = ''
    else if (openPath === null || openPath === false) openPath = null
    // replace \ by /
    if (typeof openPath === 'string') openPath = openPath.replace(/\\/, '/')
    else if (Array.isArray(openPath)) {
      openPath.map(p => p.replace(/\\/, '/'))
    }

    if (options.noBrowser) openPath = null // Backwards compatibility

    // if server is already running, just open a new browser window
    if (this.isRunning) {
      const printOpenNewMessage = (openPath: string) => {
        const path = colors(openPath, 'bold')
        const url = colors(`${this.openURL}/${path}`, 'cyan')
        message.log(`Opening new window at ${url}`)
      }

      if (openPath === null) {
        message.log(`Can't open new window for path "null"`)
        return
      }

      if (Array.isArray(openPath)) {
        openPath.forEach(p => {
          printOpenNewMessage(p)
        })
      } else {
        printOpenNewMessage(openPath)
      }

      this.launchBrowser(this.openURL, openPath, browser)
      return
    }

    /**
     * deprecation notice
     */
    // Use http-auth if configured
    if (htpasswd !== null) message.error('Sorry htpasswd does not work yet.', null, false)

    // Custom https module
    if (options.httpsModule) message.error('Sorry "httpsModule" has been removed.', null, false)

    // SPA middleware
    if (options.spa) message.error('Sorry SPA middleware has been removed.', null, false)

    /**
     * STEP: 1/4
     * Set up "express" server (https://www.npmjs.com/package/express)
     */

    // express.js
    const app = express()

    // change x-powered-by
    app.use((req, res, next) => {
      res.setHeader('X-Powered-By', 'Five Server')
      next()
    })

    // enable CORS
    if (cors) app.use(require('cors')({ credentials: true }))

    // .cache
    if (cache) app.use('/.cache', cacheMiddleware)

    // serve fiveserver files
    app.use((req, res, next) => {
      if (req.url === '/fiveserver.js') return res.type('.js').send(INJECTED_CODE)
      if (req.url === '/fiveserver/status') return res.json({ status: 'online' })

      next()
    })

    // fiveserver /public
    app.use('/fiveserver', express.static(path.join(__dirname, '../public')))

    /*
      // logger has been removed from the core
      // if you want a logger, add a custom middleware to fiveserver.config.js
    
      const morgan = require('morgan')

      module.exports = {
        middleware: [morgan('dev')]
      }

      module.exports = {
        middleware: [morgan('dev', { skip: (req, res) => res.statusCode < 400 })]
      }
    */

    // middleware
    middleware.map(function (mw) {
      if (typeof mw === 'string') {
        const ext = path.extname(mw).toLocaleLowerCase()
        if (ext !== '.js') {
          mw = require(path.join(__dirname, 'middleware', `${mw}.js`)).default
        } else {
          mw = require(mw)
        }
        if (typeof mw !== 'function') message.error(`middleware ${mw} does not return a function`, null, false)
      }
      app.use(mw)
    })

    // mount
    for (const [ROUTE, TARGET] of Object.entries(mount)) {
      const mountPath = path.resolve(process.cwd(), TARGET)
      let R = ROUTE

      // automatically watch mount paths
      if (!options.watch && watch !== false) watch.push(mountPath)

      // make sure ROUTE has a leading slash
      if (R.indexOf('/') !== 0) R = `/${R}`

      // inject code to html and php files
      app.use(R, injectCode(mountPath, PHP))

      // serve static files via express.static()
      app.use(R, express.static(mountPath))

      // log the mapping folder
      if (this.logLevel >= 1) message.log(`Mapping "${R}" to "${TARGET}"`)
    }

    // proxy
    for (const [ROUTE, TARGET] of Object.entries(proxy)) {
      const url = new URL(TARGET)

      const proxyOpts: ProxyMiddlewareOptions = {
        hash: url.hash,
        host: url.host,
        hostname: url.hostname,
        href: url.href,
        origin: url.origin,
        password: url.password,
        path: url.pathname + url.search,
        pathname: url.pathname,
        port: url.port,
        preserveHost: true,
        protocol: url.protocol,
        search: url.search,
        searchParams: url.searchParams,
        username: url.username,
        via: true
      }

      app.use(ROUTE, require('./middleware/proxy')(proxyOpts))
      if (this.logLevel >= 1) message.log(`Mapping "${ROUTE}" to "${TARGET}"`)
    }

    // find index file and modify req.url
    app.use(findIndex(root, withExtension, ['html', 'php']))

    const injectHandler = injectCode(root, PHP)

    // inject five-server script
    app.use(injectHandler)

    // serve static files (ignore php files) (don't serve index files)
    app.use(ignoreExtension(['php'], express.static(root, { index: false })))

    // inject to fallback "file"
    app.use(fallbackFile(injectHandler, file))

    // inject to any (converts and file to a .html file (if possible))
    // (makes that nice preview page)
    app.use(preview(root, this.servePreview))

    // explorer middleware (previously serve-index)
    app.use(explorer(root, { icons: true, hidden: false, dotFiles: true }))

    // no one want to see a 404 favicon error
    app.use(favicon)

    // serve 403/404 page
    app.use(notFound(root))

    // create http server
    if (_https !== null && _https !== false) {
      let httpsConfig = _https as Certificate

      if (typeof _https === 'string') {
        httpsConfig = require(path.resolve(process.cwd(), _https))
      }

      if (_https === true) {
        const fakeCert = getCertificate(path.join(workspace ? workspace : path.resolve(), '.cache'))
        httpsConfig = { key: fakeCert, cert: fakeCert }
      }

      this.httpServer = https.createServer(httpsConfig, app)
      this._protocol = 'https'
    } else {
      this.httpServer = http.createServer(app)
      this._protocol = 'http'
    }

    // start and listen at port
    await this.listen(port, host)

    const address = this.httpServer.address() as any
    //const serveHost = address.address === '0.0.0.0' ? '127.0.0.1' : address.address

    let openHost = host === '0.0.0.0' ? '127.0.0.1' : host
    if (useLocalIp) openHost = getNetworkAddress() || openHost

    //const serveURL = `${this._protocol}://${serveHost}:${address.port}`
    this._openURL = `${this._protocol}://${openHost}:${address.port}`

    message.log('')
    message.log(`  Five Server ${colors('running at:', 'green')}`)
    // message.log(colors(`  (v${VERSION} http://npmjs.com/five-server)`, 'gray'))
    message.log('')

    //let serveURLs: any = [serveURL]
    if (this.logLevel >= 1) {
      if (address.address === '0.0.0.0') {
        const interfaces = os.networkInterfaces()

        Object.keys(interfaces).forEach(key =>
          (interfaces[key] || [])
            .filter(details => details.family === 'IPv4')
            .map(detail => {
              return {
                type: detail.address.includes('127.0.0.1') ? 'Local:   ' : 'Network: ',
                host: detail.address.replace('127.0.0.1', 'localhost')
              }
            })
            .forEach(({ type, host }) => {
              const url = `${this._protocol}://${host}:${colors(address.port, 'bold')}`
              message.log(`  > ${type} ${colors(url, 'cyan')}`)
            })
        )
      } else {
        message.log(`  > Local: ${colors(`${this._protocol}://${openHost}:${colors(address.port, 'bold')}`, 'cyan')}`)
      }
      message.log('')
    }

    // donate
    donate()

    /**
     * STEP: 2/4
     * Open Browser using "open" (https://www.npmjs.com/package/open)
     */
    this.launchBrowser(this.openURL, openPath, browser)

    /**
     * STEP: 3/4
     * Make WebSocket Connection using "ws" (https://www.npmjs.com/package/ws)
     */
    const wss = new WebSocket.Server({ server: this.httpServer })

    wss.on('connection', (ws: ExtendedWebSocket, req: any) => {
      if (remoteLogs !== false) ws.send('initRemoteLogs')
      ws.send('connected')

      ws.sendWithDelay = (data: any, cb?: ((err?: Error | undefined) => void) | undefined) => {
        setTimeout(
          () => {
            ws.send(data, e => {
              if (cb) cb(e)
            })
          },
          wait,
          { once: true }
        )
      }

      // store ip
      ws.ip = req?.connection?.remoteAddress

      // store color
      const clr = this.ipColors.get(ws.ip) || this.newColor()
      this.ipColors.set(ws.ip, clr)
      ws.color = clr

      // ws.on('error', err => {
      //   message.log('WS ERROR:', err)
      // })

      ws.on('message', data => {
        try {
          if (typeof data === 'string') {
            const json = JSON.parse(data)

            if (json && json.file) {
              ws.file = json.file
            }

            const useRemoteLogs = remoteLogs === true || typeof remoteLogs === 'string'
            if (useRemoteLogs && json && json.console) {
              const ip = `[${ws.ip}]`
              const msg = json.console.message
              const T = json.console.type
              const clr = T === 'warn' ? 'yellow' : T === 'error' ? 'red' : ''

              const log = `${colors(ip, ws.color)} ${clr ? colors(msg, clr) : msg}`
              message.pretty(log, { id: 'ws' })
            }
          }
        } catch (err) {
          //
        }
      })

      ws.on('close', () => {
        this.clients = this.clients.filter(function (x) {
          return x !== ws
        })
      })

      this.clients.push(ws)
    })

    /**
     * STEP: 4/4
     * Listen for File changes using "chokidar" (https://www.npmjs.com/package/chokidar)
     */
    let ignored: any = [
      function (testPath) {
        // Always ignore dotfiles (important e.g. because editor hidden temp files)
        return testPath !== '.' && /(^[.#]|(?:__|~)$)/.test(path.basename(testPath))
      },
      /(^|[/\\])\../, // ignore dotfile
      '**/node_modules/**',
      '**/bower_components/**',
      '**/jspm_packages/**'
    ]
    if (options.ignore) {
      ignored = ignored.concat(options.ignore)
    }
    if (options.ignorePattern) {
      ignored.push(options.ignorePattern)
    }

    // Setup file watcher
    if (watch === false) return
    this.watcher = chokidar.watch(watch as any, {
      cwd: cwd,
      ignoreInitial: true,
      ignored: ignored
    })

    const handleChange = changePath => {
      const cssChange = path.extname(changePath) === '.css' && injectCss
      if (this.logLevel >= 1) {
        const five = colors(colors('[Five Server]', 'bold'), 'cyan')
        const msg = cssChange ? colors('CSS change detected', 'magenta') : colors('change detected', 'cyan')
        const file = colors(changePath.replace(path.resolve(root), ''), 'gray')

        message.pretty(`${five} ${msg} ${file}`, { id: cssChange ? 'cssChange' : 'change' })
      }

      const htmlChange = path.extname(changePath) === '.html'
      const phpChange = path.extname(changePath) === '.php'
      if ((htmlChange || phpChange) && injectBody) return

      this.clients.forEach(ws => {
        if (ws) ws.sendWithDelay(cssChange ? 'refreshcss' : 'reload')
      })
    }

    this.watcher
      .on('change', handleChange)
      .on('add', handleChange)
      .on('unlink', handleChange)
      .on('addDir', handleChange)
      .on('unlinkDir', handleChange)
      .on('ready', () => {
        if (this.logLevel > 1) message.log(colors('Ready for changes', 'cyan'))
      })
      .on('error', err => {
        message.log(colors('ERROR:', 'red'), err)
      })
  }

  private async listen(port: any, host: any): Promise<void> {
    return new Promise((resolve, reject) => {
      // Handle server startup errors
      this.httpServer.once('error', e => {
        // @ts-ignore
        if (e.message === 'EADDRINUSE' || (e.code && e.code === 'EADDRINUSE')) {
          // const serveURL = `${this._protocol}://${host}:${port}`
          message.log(colors(`Port ${port} is already in use. Trying another port.`, 'yellow'))
          setTimeout(() => {
            this.listen(0, host) // 0 means random port
          }, 1000)
        } else {
          message.error(colors(e.toString(), 'red'), null, false)
          this.shutdown()
          reject(e.message)
        }
      })

      this.httpServer.on('connection', socket => {
        this.sockets.add(socket)
      })

      // Handle successful httpServer
      this.httpServer.once('listening', (/*e*/) => {
        resolve()
      })

      this.httpServer.listen(port, host)
    })
  }

  /**
   * Navigate the browser to another page.
   * @param url Navigates to the given URL.
   */
  public navigate(url: string) {
    this.clients.forEach(ws => {
      if (ws) ws.sendWithDelay(JSON.stringify({ navigate: url }))
    })
  }

  /** Launch a new browser window. */
  public async launchBrowser(
    openURL: string,
    path: string | boolean | string[] | null | undefined,
    browser?: string | string[]
  ) {
    await openBrowser(openURL, path, browser)
  }

  /** Reloads all browser windows */
  public reloadBrowserWindow() {
    this.clients.forEach(ws => {
      if (ws) ws.sendWithDelay('reload')
    })
  }

  /** Send message to the client. (Will show a popup in the Browser) */
  public sendMessage(file: string, msg: string | string[], type = 'info') {
    this.clients.forEach(ws => {
      // send message or message[s]
      const content = typeof msg === 'string' ? { message: msg } : { messages: msg }
      if (ws && ws.file === file) ws.send(JSON.stringify(content))
    })
  }

  /** Manually refresh css */
  public refreshCSS(showPopup = true) {
    this.clients.forEach(ws => {
      if (ws) ws.sendWithDelay(showPopup ? 'refreshcss' : 'refreshcss-silent')
    })
  }

  /** Inject a a new <body> into the DOM. (Better prepend parseBody first) */
  public updateBody(file: string, body: any) {
    this.clients.forEach(ws => {
      if (ws && ws.file === file) ws.send(JSON.stringify({ body, hot: true }))
    })
  }

  public highlightSelector(file: string, selector: string) {
    // TODO(yandeu): add this
  }

  /** @deprecated */
  public highlight(file: string, position: { line: number; character: number }) {
    this.clients.forEach(ws => {
      if (ws && ws.file === file) ws.sendWithDelay(JSON.stringify({ position }))
    })
  }

  /** Close five-server (same as shutdown()) */
  public get close() {
    return this.shutdown
  }

  /** Shutdown five-server */
  public async shutdown(): Promise<void> {
    this._parseBody?.terminate()

    if (this.watcher) {
      await this.watcher.close()
    }

    for (const client of this.clients) {
      await client.close()
    }

    for (const socket of this.sockets) {
      socket.destroy()
      this.sockets.delete(socket)
    }

    return new Promise((resolve, reject) => {
      if (this.httpServer && this.httpServer.listening) {
        this.httpServer.close(err => {
          if (err) return reject(err.message)
          else {
            resolve()
            // @ts-ignore
            this.httpServer = null
          }
        })
      } else {
        return resolve()
      }
    })
  }
}
