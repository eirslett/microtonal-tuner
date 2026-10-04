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
 *
 * Pass a frequency window to measure cents around a coarse estimate. The lag
 * search is padded by a couple of samples so the parabolic peak is not clipped.
 */
export function detectPitch(
  buffer: Float32Array,
  sampleRate: number,
  range?: { minFreq: number; maxFreq: number },
): number | null {
  const minFreq = range?.minFreq ?? 150
  const maxFreq = range?.maxFreq ?? 2000
  const threshold = 0.15
  const pad = range ? 2 : 0
  const tauMax = Math.min(Math.floor(buffer.length / 2) - pad, Math.floor(sampleRate / minFreq) + pad)
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq) - pad)
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
  const low = range ? minFreq * 2 ** (-20 / 1200) : minFreq
  const high = range ? maxFreq * 2 ** (20 / 1200) : maxFreq
  if (frequency < low || frequency > high) return null
  return frequency
}

/** Lock cents with YIN inside a narrow band around a coarse pitch estimate. */
export function refinePitch(buffer: Float32Array, sampleRate: number, coarseHz: number): number {
  if (!Number.isFinite(coarseHz) || coarseHz <= 0) return coarseHz
  const ratio = 2 ** (50 / 1200)
  const refined = detectPitch(buffer, sampleRate, {
    minFreq: coarseHz / ratio,
    maxFreq: coarseHz * ratio,
  })
  return refined ?? coarseHz
}

export function rms(buffer: Float32Array): number {
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i]
  return Math.sqrt(sum / buffer.length)
}
