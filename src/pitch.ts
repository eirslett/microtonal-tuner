export const PITCH_ALGORITHM_CHOICES = ['crepe', 'yin'] as const
export type PitchAlgorithm = (typeof PITCH_ALGORITHM_CHOICES)[number]
const PITCH_ALGORITHM_STORAGE_KEY = 'pitch-algorithm'
const DEFAULT_PITCH_ALGORITHM: PitchAlgorithm = 'crepe'

export function isPitchAlgorithm(value: string): value is PitchAlgorithm {
  return value === 'crepe' || value === 'yin'
}

export function pitchAlgorithmLabel(algorithm: PitchAlgorithm): string {
  return algorithm === 'crepe' ? 'CREPE' : 'YIN'
}

export function readStoredPitchAlgorithm(): PitchAlgorithm {
  try {
    const stored = localStorage.getItem(PITCH_ALGORITHM_STORAGE_KEY)
    if (stored && isPitchAlgorithm(stored)) return stored
  } catch {
    // localStorage can throw when storage is blocked.
  }
  return DEFAULT_PITCH_ALGORITHM
}

export function storePitchAlgorithm(algorithm: PitchAlgorithm): void {
  try {
    localStorage.setItem(PITCH_ALGORITHM_STORAGE_KEY, algorithm)
  } catch {
    // Ignore a full or blocked store; the choice still applies for this visit.
  }
}

/**
 * YIN pitch detector. Monophonic, and stable enough for an oboe fundamental
 * with a strong harmonic series.
 */
export function detectPitch(buffer: Float32Array, sampleRate: number): number | null {
  const minFreq = 150
  const maxFreq = 2000
  const threshold = 0.15
  const tauMax = Math.min(Math.floor(buffer.length / 2), Math.floor(sampleRate / minFreq))
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq))
  if (tauMax <= tauMin) return null

  const yin = new Float32Array(tauMax + 1)
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0
    const limit = buffer.length - tau
    for (let i = 0; i < limit; i++) {
      const delta = buffer[i] - buffer[i + tau]
      sum += delta * delta
    }
    yin[tau] = sum
  }

  let running = 0
  yin[0] = 1
  for (let tau = 1; tau <= tauMax; tau++) {
    running += yin[tau]
    yin[tau] = running === 0 ? 1 : (yin[tau] * tau) / running
  }

  let tau = tauMin
  let found = -1
  while (tau <= tauMax) {
    if (yin[tau] < threshold) {
      while (tau + 1 <= tauMax && yin[tau + 1] < yin[tau]) tau++
      found = tau
      break
    }
    tau++
  }
  if (found < 0) return null

  const prev = yin[found - 1]
  const next = yin[found + 1] ?? yin[found]
  const denom = 2 * yin[found] - next - prev
  const better = denom === 0 ? found : found + (next - prev) / (2 * denom)
  if (!Number.isFinite(better) || better <= 0) return null

  const frequency = sampleRate / better
  if (frequency < minFreq || frequency > maxFreq) return null
  return frequency
}

export function rms(buffer: Float32Array): number {
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i]
  return Math.sqrt(sum / buffer.length)
}
