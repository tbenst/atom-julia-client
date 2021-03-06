'use babel'

import { client } from '../connection'
import tcp from '../connection/process/tcp'
import { CompositeDisposable } from 'atom'
import { paths } from '../misc'
import modules from './modules'
import * as pty from 'node-pty-prebuilt'
import { debounce, once } from 'underscore-plus'
import { customSelector } from '../ui'

var { changeprompt, changemodule, resetprompt, validatepath, fullpath } =
      client.import({msg: ['changeprompt', 'changemodule', 'resetprompt'], rpc: ['validatepath', 'fullpath']})

let uriRegex
if (process.platform == 'win32') {
  uriRegex = /((([a-zA-Z]:|\.\.?|\~)|([^\0<>\?\|\/\s!$`&*()\[\]+'":;])+)?((\\|\/)([^\0<>\?\|\/\s!$`&*()\[\]+'":;])+)+)(\:\d+)?/
} else {
  uriRegex = /(((\.\.?|\~)|([^\0\s!$`&*()\[\]+'":;\\])+)?(\/([^\0\s!$`&*()\[\]+'":;\\])+)+)(\:\d+)?/
}

var whitelistedKeybindingsREPL = []
var whitelistedKeybindingsTerminal = []

export var terminal

export function activate (ink) {
  if (atom.config.get('julia-client.consoleOptions.consoleStyle') != 'REPL-based') return

  let subs = new CompositeDisposable()

  subs.add(atom.config.observe('julia-client.consoleOptions.whitelistedKeybindingsREPL', (kbds) => {
    whitelistedKeybindingsREPL = kbds.map(s => s.toLowerCase())
  }))
  subs.add(atom.config.observe('julia-client.consoleOptions.whitelistedKeybindingsTerminal', (kbds) => {
    whitelistedKeybindingsTerminal = kbds.map(s => s.toLowerCase())
  }))

  terminal = ink.InkTerminal.fromId('julia-terminal', {
    scrollback: atom.config.get('julia-client.consoleOptions.maximumConsoleSize'),
    cursorStyle: atom.config.get('julia-client.consoleOptions.cursorStyle')
  })

  terminal.getTitle = () => {return 'REPL'}
  terminal.class = 'julia-terminal'

  terminal.write('\x1b[1m\x1b[32mPress Enter to start Julia. \x1b[0m\n\r')
  terminal.startRequested = () => {
    terminal.write('Starting Julia...\n\r')
    client.boot()
  }

  terminal.attachCustomKeyEventHandler(e => {
    if (whitelistedKeybindingsREPL.indexOf(atom.keymaps.keystrokeForKeyboardEvent(e)) > -1) {
      return false
    }
    return e
  })

  modules.onDidChange(debounce(() => changemodule({mod: modules.current(), cols: terminal.terminal.cols}), 200))

  client.handle({
    updateWorkspace: () => require('./workspace').update(),
    clearconsole: () => terminal.clear(),
    cursorpos: () => {
      terminal.write('\x1b[0m')
      return [terminal.terminal.buffer.x, terminal.terminal.buffer.y]
    }
  })

  let linkHandler, promptObserver
  client.onBoot((proc) => {
    terminal.attach(proc.ty)

    if (proc.flush) {
      proc.flush((d) => terminal.write(d), (d) => terminal.write(d))
    }

    promptObserver = atom.config.observe('julia-client.consoleOptions.prompt', (prompt) => {
      changeprompt(prompt + ' ')
    })

    linkHandler = (event, uri) => {
      let m = uri.match(/(.+)(?:\:(\d+))$/)
      fullpath(m[1]).then((path) => ink.Opener.open(path, parseInt(m[2]) - 1, {pending: true}))
    }

    let validator = (uri, cb) => {
      validatepath(uri).then((isvalid) => {
        cb(isvalid)
      })
    }

    // doesn't handle multiline URIs properly due to upstream bug (xterm.js#24)
    terminal.terminal.registerLinkMatcher(uriRegex, linkHandler, {validationCallback: validator})
  })

  client.onDetached(() => {
    terminal.detach()
    terminal.write('\n\r\x1b[1m\r\x1b[31mJulia has exited.\x1b[0m Press Enter to start a new session.\n\r')
    terminal.terminal.deregisterLinkMatcher(linkHandler)
    promptObserver.dispose()
    client.ipc.loading.reset()
  })


  subs.add(atom.commands.add('atom-workspace', 'julia-client:open-console', () => {
    terminal.open().then(() => terminal.show())
  }))

  subs.add(atom.commands.add('atom-workspace', 'julia-client:clear-console', () => {
    terminal.clear()
  }))

  subs.add(atom.commands.add('.julia-terminal', 'julia-client:copy-or-interrupt', () => {
    if (!terminal.copySelection()) {
      atom.commands.dispatch(terminal.view, 'julia-client:interrupt-julia')
    }
  }))

  subs.add(atom.commands.add('atom-workspace', 'julia-client:new-terminal', () => {
    let term = ink.InkTerminal.fromId(`terminal-julia-${Math.floor(Math.random()*10000000)}`, {
      scrollback: atom.config.get('julia-client.consoleOptions.maximumConsoleSize'),
      cursorStyle: atom.config.get('julia-client.consoleOptions.cursorStyle')
    })
    term.attachCustomKeyEventHandler(handleWhitelistedKeybindingTerminal)
    shellPty().then(({pty, cwd}) => {
      term.attach(pty, true, cwd)
      term.open().then(() => term.show())
    }).catch(() => {})
  }))

  // handle deserialized terminals
  atom.workspace.getPaneItems().forEach((item) => {
    if (item.id && item.name === 'InkTerminal' && item.id.match(/terminal\-julia\-\d+/)) {
      if (!item.ty) {
        item.attachCustomKeyEventHandler(handleWhitelistedKeybindingTerminal)
        shellPty(item.persistentState.cwd)
          .then(({pty, cwd}) => item.attach(pty, true, cwd))
          .catch(() => {})
      }
    }
  })
}

function handleWhitelistedKeybindingTerminal (e) {
  if (whitelistedKeybindingsTerminal.indexOf(atom.keymaps.keystrokeForKeyboardEvent(e)) > -1) {
    return false
  }
  return e
}

function shellPty (cwd) {
  return new Promise((resolve, reject) => {
    let pr
    if (cwd) {
      pr = new Promise((resolve) => resolve(cwd))
    } else {
      pr = customSelector.show(atom.workspace.project.getDirectories().map((el) => el.path), {emptyMessage: 'Enter a custom path above.'})
    }
    pr.then((cwd) => {
      if (cwd) {
        cwd = paths.expandHome(cwd)
        resolve({
          pty: pty.fork(atom.config.get("julia-client.consoleOptions.shell"), [], {
            cols: 100,
            rows: 30,
            cwd: cwd
          }),
          cwd: cwd})
      } else {
        reject()
      }
    })
  })
}

export function deactivate () {
  if (subs) subs.dispose()
}
