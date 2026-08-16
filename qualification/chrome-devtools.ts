interface DevToolsTarget {
  webSocketDebuggerUrl?: string
  type?: string
  url?: string
}

interface RuntimeExceptionDetails {
  text?: string
  exception?: { description?: string }
}

interface RuntimeResponse {
  id: number
  result?: {
    exceptionDetails?: RuntimeExceptionDetails
    result?: { value?: unknown }
  }
  error?: { message?: string }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

export function commandOptions(arguments_: readonly string[] = process.argv.slice(2)): Record<string, string> {
  return Object.fromEntries(arguments_.map((argument) => {
    const [key, ...value] = argument.replace(/^--/, '').split('=')
    return [key, value.join('=')]
  }))
}

export class ChromeRuntime {
  readonly #socket: WebSocket
  readonly #pending = new Map<number, PendingRequest>()
  #nextId = 0

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as RuntimeResponse
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      const exception = message.result?.exceptionDetails
      if (exception) {
        pending.reject(new Error(
          exception.exception?.description ?? exception.text ?? JSON.stringify(exception),
        ))
      } else if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
      } else {
        pending.resolve(message.result?.result?.value)
      }
    }
  }

  static async connect(endpoint = 'http://127.0.0.1:9222/json'): Promise<ChromeRuntime> {
    const response = await fetch(endpoint)
    if (!response.ok) throw new Error(`DevTools discovery failed: HTTP ${response.status}`)
    const targets = await response.json() as DevToolsTarget[]
    const target = targets.find((candidate) => candidate.type === 'page'
      && !candidate.url?.startsWith('devtools://')) ?? targets[0]
    const address = target?.webSocketDebuggerUrl
    if (!address) throw new Error('Android WebView DevTools target is unavailable')
    const socket = new WebSocket(address)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error('Unable to connect to Android WebView DevTools'))
    })
    return new ChromeRuntime(socket)
  }

  evaluate<T>(expression: string, userGesture = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.#nextId
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      })
      this.#socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true, userGesture },
      }))
    })
  }

  close(): void {
    this.#socket.close()
  }
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
