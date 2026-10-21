/** Tiny zero-dep concurrency limiter (p-limit style). */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>

export function createLimiter(concurrency: number): Limiter {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error(`Invalid concurrency: ${concurrency}`)
  }
  let active = 0
  const waiting: Array<() => void> = []
  const release = (): void => {
    active -= 1
    const next = waiting.shift()
    if (next) next()
  }
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active += 1
        task().then(
          (value) => {
            release()
            resolve(value)
          },
          (error) => {
            release()
            reject(error)
          },
        )
      }
      if (active < concurrency) run()
      else waiting.push(run)
    })
}
