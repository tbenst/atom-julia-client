'use babel'

import { CompositeDisposable } from 'atom'
import { client } from '../connection'

let subs, linter

export function activate () {
  subs = new CompositeDisposable()
}

export function deactivate () {
  subs.dispose()
}

export function consumeIndie (registerIndie) {
   linter = registerIndie({
    name: 'Traceur'
  })

  client.handle({
    staticLint: (warnings) => {
      linter.setAllMessages(warnings)
    },
    clearLint: () => {
      linter.clearMessages()
    }
  })
}
