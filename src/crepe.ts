import * as ort from 'onnxruntime-web/wasm'
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'

const MODEL_URL = `${import.meta.env.BASE_URL}models/crepe-tiny.onnx`
const CREPE_SAMPLE_RATE = 16_000
const FRAME_LENGTH = 1024
const BIN_COUNT = 360
const CONFIDENCE_MIN = 0.5
const CENTS_OFFSET = 1997.3794084376191

const CENTS = Float64Array.from(
  { length: BIN_COUNT },
  (_, index) => (index * 7180) / (BIN_COUNT - 1) + CENTS_OFFSET,
)

let runtimeReady = false

function configureRuntime(): void {
  if (runtimeReady) return
  runtimeReady = true
  ort.env.wasm.numThreads = 1
  ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl }
}

/** Samples of device-rate audio that cover one 1024-sample, 16 kHz CREPE frame. */
export function crepeWindowLength(sampleRate: number): number {
  return Math.ceil(((FRAME_LENGTH - 1) * sampleRate) / CREPE_SAMPLE_RATE) + 1
}

function resampleToFrame(samples: Float32Array, sampleRate: number): Float32Array {
  const frame = new Float32Array(FRAME_LENGTH)
  const step = sampleRate / CREPE_SAMPLE_RATE
  const last = samples.length - 1
  for (let index = 0; index < FRAME_LENGTH; index++) {
    const position = index * step
    const left = Math.floor(position)
    const fraction = position - left
    const a = samples[Math.min(left, last)] ?? 0
    const b = samples[Math.min(left + 1, last)] ?? a
    frame[index] = a + (b - a) * fraction
  }

  let mean = 0
  for (let index = 0; index < FRAME_LENGTH; index++) mean += frame[index]
  mean /= FRAME_LENGTH

  let variance = 0
  for (let index = 0; index < FRAME_LENGTH; index++) {
    const delta = frame[index] - mean
    variance += delta * delta
  }
  const deviation = Math.sqrt(variance / FRAME_LENGTH)
  const scale = deviation < 1e-8 ? 0 : 1 / deviation
  for (let index = 0; index < FRAME_LENGTH; index++) frame[index] = (frame[index] - mean) * scale
  return frame
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value))
}

function decode(raw: ArrayLike<number>): number | null {
  let peak = Number.NEGATIVE_INFINITY
  let center = 0
  let logits = false
  for (let index = 0; index < BIN_COUNT; index++) {
    const value = raw[index] ?? 0
    if (value > 1.01 || value < -0.01) logits = true
    if (value > peak) {
      peak = value
      center = index
    }
  }

  const activation = (index: number) => {
    const value = raw[index] ?? 0
    return logits ? sigmoid(value) : value
  }
  const confidence = logits ? sigmoid(peak) : peak
  if (confidence < CONFIDENCE_MIN) return null

  const start = Math.max(0, center - 4)
  const end = Math.min(BIN_COUNT, center + 5)
  let weighted = 0
  let weight = 0
  for (let index = start; index < end; index++) {
    const salience = activation(index)
    weighted += salience * CENTS[index]
    weight += salience
  }
  if (weight <= 0) return null

  const cents = weighted / weight
  return 10 * 2 ** (cents / 1200)
}

/**
 * Tiny CREPE (Kim et al., ICASSP 2018). Weights are the MIT-licensed tiny model
 * from marl/crepe, exported to ONNX.
 */
export class CrepePitch {
  private session: ort.InferenceSession | null = null
  private loading: Promise<void> | null = null

  load(): Promise<void> {
    this.loading ??= this.start()
    return this.loading
  }

  private async start(): Promise<void> {
    try {
      configureRuntime()
      this.session = await ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ['wasm'],
      })
    } catch (error) {
      this.loading = null
      throw error
    }
  }

  async detect(samples: Float32Array, sampleRate: number): Promise<number | null> {
    await this.load()
    const session = this.session
    if (!session) return null

    const frame = resampleToFrame(samples, sampleRate)
    const input = new ort.Tensor('float32', frame, [1, FRAME_LENGTH])
    const outputs = await session.run({ frames: input })
    const name = session.outputNames.includes('probabilities') ? 'probabilities' : session.outputNames[0]
    const output = name ? outputs[name] : undefined
    if (!output || !('data' in output) || !(output.data instanceof Float32Array)) return null
    return decode(output.data)
  }
}

export class SampleRing {
  private readonly data: Float32Array
  private write = 0
  private filled = 0

  constructor(capacity = 16_384) {
    this.data = new Float32Array(capacity)
  }

  push(chunk: ArrayLike<number>): void {
    const capacity = this.data.length
    for (let index = 0; index < chunk.length; index++) {
      this.data[this.write] = chunk[index] ?? 0
      this.write = (this.write + 1) % capacity
    }
    this.filled = Math.min(capacity, this.filled + chunk.length)
  }

  latest(count: number): Float32Array | null {
    if (count <= 0 || this.filled < count || count > this.data.length) return null
    const out = new Float32Array(count)
    const capacity = this.data.length
    let index = (this.write - count + capacity) % capacity
    for (let offset = 0; offset < count; offset++) {
      out[offset] = this.data[index]
      index = (index + 1) % capacity
    }
    return out
  }

  clear(): void {
    this.write = 0
    this.filled = 0
  }
}
