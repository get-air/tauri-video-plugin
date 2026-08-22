export function errorMessage(reason: unknown, depth = 0): string {
  if (depth > 4) return String(reason)
  if (reason instanceof Error) {
    const cause = reason.cause === undefined
      ? ''
      : errorMessage(reason.cause, depth + 1)
    return cause && cause !== reason.message
      ? `${reason.message}: ${cause}`
      : reason.message
  }
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object' && reason) {
    const value = reason as Record<string, unknown>
    const message = typeof value.message === 'string' ? value.message : ''
    const cause = value.cause === undefined ? '' : errorMessage(value.cause, depth + 1)
    if (message && cause && cause !== message) return `${message}: ${cause}`
    if (message || cause) return message || cause
    try {
      return JSON.stringify(reason)
    } catch {
      return String(reason)
    }
  }
  return String(reason)
}
