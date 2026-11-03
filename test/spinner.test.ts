import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureLogger, spinUpdate, spinClear } from '../src/utils/logger.ts'

/** Capture the logger's stdout writes (frames are braille glyphs prefixed to the label). */
function captureWrites(): { writes: string[]; restore: () => void } {
  const writes: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk))
    return true
  })
  return { writes, restore: () => spy.mockRestore() }
}

const resetLogger = (): void => {
  configureLogger({ isTTY: false, progress: 'auto', quiet: false, noColor: true })
}

afterEach(() => {
  vi.useRealTimers()
  resetLogger()
})

describe('time-driven spinner (v1.1.1 loader fix)', () => {
  it('rotates braille frames on its own clock — a frozen count must not look hung', () => {
    vi.useFakeTimers()
    configureLogger({ isTTY: true, progress: 'auto', quiet: false, noColor: true })
    const { writes, restore } = captureWrites()
    try {
      spinUpdate('measuring 3/12 folders')
      // initial paint: frame 0 glyph + label
      expect(writes[0]).toContain('⠋')
      expect(writes[0]).toContain('measuring 3/12 folders')
      const initial = writes.length

      // the rotation is independent of the label: pure time moves the glyph
      vi.advanceTimersByTime(70)
      expect(writes).toHaveLength(initial + 1)
      expect(writes.at(-1)).toContain('⠙')
      vi.advanceTimersByTime(70)
      expect(writes.at(-1)).toContain('⠹')

      // refreshing the label does not paint — the timer carries the update
      spinUpdate('measuring 4/12 folders')
      expect(writes).toHaveLength(initial + 2)
      vi.advanceTimersByTime(70)
      expect(writes.at(-1)).toContain('⠸')
      expect(writes.at(-1)).toContain('measuring 4/12 folders')

      // spinClear stops the clock — time passing stays silent
      spinClear()
      const afterClear = writes.length
      vi.advanceTimersByTime(7000)
      expect(writes).toHaveLength(afterClear)
    } finally {
      restore()
    }
  })

  it('forced pipe mode paints one static line per update — no timer flood', () => {
    vi.useFakeTimers()
    configureLogger({ isTTY: false, progress: 'on', quiet: false, noColor: true })
    const { writes, restore } = captureWrites()
    try {
      spinUpdate('🗑  1/5 folders…')
      expect(writes).toHaveLength(1)
      vi.advanceTimersByTime(7000)
      expect(writes).toHaveLength(1) // interval never installed off-TTY
      spinUpdate('🗑  2/5 folders…')
      expect(writes).toHaveLength(2)
      expect(writes.at(-1)).toContain('2/5')
      spinClear()
      expect(writes).toHaveLength(3) // the \r\x1b[2K clear line
    } finally {
      restore()
    }
  })

  it('progress auto + non-TTY stays fully silent (hermetic CI output)', () => {
    configureLogger({ isTTY: false, progress: 'auto', quiet: false, noColor: true })
    const { writes, restore } = captureWrites()
    try {
      spinUpdate('hidden loader')
      spinClear()
      expect(writes).toHaveLength(0)
    } finally {
      restore()
    }
  })

  it('quiet mode mutes the spinner even on a TTY (--json payload stays clean)', () => {
    configureLogger({ isTTY: true, progress: 'on', quiet: true, noColor: true })
    const { writes, restore } = captureWrites()
    try {
      spinUpdate('silent')
      spinClear()
      expect(writes).toHaveLength(0)
    } finally {
      restore()
    }
  })
})
