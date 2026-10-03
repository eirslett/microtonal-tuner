/** Concert A. 36-EDO contains 12-EDO, so every chromatic pitch is exact. */
export const A4_HZ = 442
export const A4_MIN = 438
export const A4_MAX = 445
export const A4_CHOICES = Array.from({ length: A4_MAX - A4_MIN + 1 }, (_, index) => A4_MIN + index)
const A4_STORAGE_KEY = 'a4-hz'

export const EDO = 36
/** One equal step. A third of a semitone. */
export const STEP_CENTS = 1200 / EDO
export const HALF_STEP_CENTS = STEP_CENTS / 2

const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'] as const

/** Steps from C0 up to A4: four octaves, then the nine semitones from C to A, three steps each. */
const A4_STEPS_FROM_C0 = 4 * EDO + 9 * 3

export type Arrow = '' | '↑' | '↓'

export type SpelledPitch = {
  arrow: Arrow
  name: (typeof NAMES)[number]
  octave: number
  /** 0 is C, 27 is A. ↓C is 35, and its octave number is the C above. */
  pitchClass: number
  /** Octave of the C that begins this 36-step ring. */
  cOctave: number
  hz: number
}

export type PitchReading = SpelledPitch & {
  heardHz: number
  /** Signed cents from the nearest 36-EDO pitch, roughly ±16.7. */
  cents: number
}

function roundHalfAway(n: number): number {
  return (n >= 0 ? 1 : -1) * Math.round(Math.abs(n))
}

export function isConcertA(hz: number): boolean {
  return Number.isInteger(hz) && hz >= A4_MIN && hz <= A4_MAX
}

export function readStoredA4(): number {
  try {
    const stored = Number(localStorage.getItem(A4_STORAGE_KEY))
    if (isConcertA(stored)) return stored
  } catch {
    // localStorage can throw when storage is blocked.
  }
  return A4_HZ
}

export function storeA4(hz: number): void {
  try {
    localStorage.setItem(A4_STORAGE_KEY, String(hz))
  } catch {
    // Ignore a full or blocked store; the choice still applies for this visit.
  }
}

export function hzFromStepsAboveA4(steps: number, a4Hz: number): number {
  return a4Hz * 2 ** (steps / EDO)
}

export function spellPitchClass(pitchClass: number, cOctave: number, a4Hz: number): SpelledPitch {
  const pc = ((pitchClass % EDO) + EDO) % EDO
  const semitone = Math.floor(pc / 3)
  const offset = pc % 3
  let nameIndex = semitone
  let octave = cOctave
  let arrow: Arrow = ''
  if (offset === 1) arrow = '↑'
  if (offset === 2) {
    arrow = '↓'
    nameIndex = (semitone + 1) % 12
    if (nameIndex === 0) octave += 1
  }
  const stepsFromC0 = cOctave * EDO + pc
  return {
    arrow,
    name: NAMES[nameIndex],
    octave,
    pitchClass: pc,
    cOctave,
    hz: hzFromStepsAboveA4(stepsFromC0 - A4_STEPS_FROM_C0, a4Hz),
  }
}

export function describeFrequency(heardHz: number, a4Hz: number): PitchReading {
  const steps = EDO * Math.log2(heardHz / a4Hz)
  const nearest = roundHalfAway(steps)
  const stepsFromC0 = nearest + A4_STEPS_FROM_C0
  const cOctave = Math.floor(stepsFromC0 / EDO)
  const pc = stepsFromC0 - cOctave * EDO
  return {
    ...spellPitchClass(pc, cOctave, a4Hz),
    heardHz,
    cents: (steps - nearest) * STEP_CENTS,
  }
}

export function chromaticLabel(pitchClass: number): string | null {
  if (pitchClass % 3 !== 0) return null
  return NAMES[pitchClass / 3]
}

export function formatCents(cents: number): string {
  const abs = Math.round(Math.abs(cents) * 10) / 10
  if (abs === 0) return '0.0'
  return `${cents > 0 ? '+' : '−'}${abs.toFixed(1)}`
}

export function intonationWord(cents: number): string {
  const abs = Math.abs(cents)
  if (abs < 5) return 'In tune'
  if (cents < 0) return abs < 10 ? 'A little flat' : 'Flat'
  return abs < 10 ? 'A little sharp' : 'Sharp'
}

export function pitchLabel(pitch: Pick<SpelledPitch, 'arrow' | 'name' | 'octave'>): string {
  return `${pitch.arrow}${pitch.name}${pitch.octave}`
}
