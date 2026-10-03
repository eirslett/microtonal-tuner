/** Concert A. 12, 24, and 36 all contain the chromatic pitches. */
export const A4_HZ = 442
export const A4_MIN = 438
export const A4_MAX = 445
export const A4_CHOICES = Array.from({ length: A4_MAX - A4_MIN + 1 }, (_, index) => A4_MIN + index)
const A4_STORAGE_KEY = 'a4-hz'

export const EDO_CHOICES = [12, 24, 36] as const
export type Edo = (typeof EDO_CHOICES)[number]
const EDO_STORAGE_KEY = 'edo'
const DEFAULT_EDO: Edo = 36

const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'] as const

/** How many equal steps sit inside one chromatic semitone. */
function stepsPerSemitone(edo: Edo): number {
  return edo / 12
}

export function stepCents(edo: Edo): number {
  return 1200 / edo
}

export function halfStepCents(edo: Edo): number {
  return stepCents(edo) / 2
}

/** Pitch class of A. The compass puts this step at the top. */
export function a4PitchClass(edo: Edo): number {
  return 9 * stepsPerSemitone(edo)
}

/** Steps from C0 up to A4. */
function a4StepsFromC0(edo: Edo): number {
  return 4 * edo + a4PitchClass(edo)
}

export type Arrow = '' | '↑' | '↓'

export type SpelledPitch = {
  arrow: Arrow
  name: (typeof NAMES)[number]
  octave: number
  /** 0 is C. A is 9 chromatic semitones up, counted in this EDO's steps. */
  pitchClass: number
  /** Octave of the C that begins this ring of steps. */
  cOctave: number
  hz: number
}

export type PitchReading = SpelledPitch & {
  heardHz: number
  /** Signed cents from the nearest pitch in the active EDO. */
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

export function isEdo(value: number): value is Edo {
  return value === 12 || value === 24 || value === 36
}

export function readStoredEdo(): Edo {
  try {
    const stored = Number(localStorage.getItem(EDO_STORAGE_KEY))
    if (isEdo(stored)) return stored
  } catch {
    // localStorage can throw when storage is blocked.
  }
  return DEFAULT_EDO
}

export function storeEdo(edo: Edo): void {
  try {
    localStorage.setItem(EDO_STORAGE_KEY, String(edo))
  } catch {
    // Ignore a full or blocked store; the choice still applies for this visit.
  }
}

export function formatStepCents(edo: Edo): string {
  const cents = stepCents(edo)
  return Number.isInteger(cents) ? cents.toFixed(0) : cents.toFixed(1)
}

/** Keep a held pitch near the same place in the octave when the division changes. */
export function remapPitchClass(pitchClass: number, from: Edo, to: Edo): number {
  if (from === to) return pitchClass
  const mapped = roundHalfAway((pitchClass / from) * to)
  return ((mapped % to) + to) % to
}

export function hzFromStepsAboveA4(steps: number, a4Hz: number, edo: Edo): number {
  return a4Hz * 2 ** (steps / edo)
}

export function spellPitchClass(
  pitchClass: number,
  cOctave: number,
  a4Hz: number,
  edo: Edo,
): SpelledPitch {
  const pc = ((pitchClass % edo) + edo) % edo
  const per = stepsPerSemitone(edo)
  const semitone = Math.floor(pc / per)
  const offset = pc % per
  let nameIndex = semitone
  let octave = cOctave
  let arrow: Arrow = ''
  if (offset === per - 1 && per > 2) {
    arrow = '↓'
    nameIndex = (semitone + 1) % 12
    if (nameIndex === 0) octave += 1
  } else if (offset > 0) {
    arrow = '↑'
  }
  const stepsFromC0 = cOctave * edo + pc
  return {
    arrow,
    name: NAMES[nameIndex],
    octave,
    pitchClass: pc,
    cOctave,
    hz: hzFromStepsAboveA4(stepsFromC0 - a4StepsFromC0(edo), a4Hz, edo),
  }
}

export function describeFrequency(heardHz: number, a4Hz: number, edo: Edo): PitchReading {
  const steps = edo * Math.log2(heardHz / a4Hz)
  const nearest = roundHalfAway(steps)
  const stepsFromC0 = nearest + a4StepsFromC0(edo)
  const cOctave = Math.floor(stepsFromC0 / edo)
  const pc = stepsFromC0 - cOctave * edo
  return {
    ...spellPitchClass(pc, cOctave, a4Hz, edo),
    heardHz,
    cents: (steps - nearest) * stepCents(edo),
  }
}

export function chromaticLabel(pitchClass: number, edo: Edo): string | null {
  const per = stepsPerSemitone(edo)
  if (pitchClass % per !== 0) return null
  return NAMES[pitchClass / per]
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
