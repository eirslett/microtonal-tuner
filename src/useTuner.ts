import { useCallback, useEffect, useRef, useState } from 'react'
import {
  A4_HZ,
  describeFrequency,
  remapPitchClass,
  spellPitchClass,
  type Edo,
  type PitchReading,
} from './edo'
import { detectPitch, rms } from './pitch'

const TRACE_LENGTH = 96
const ANALYSIS_INTERVAL_MS = 45
const SILENCE_HOLD_MS = 220
const SILENCE_RMS = 0.008

export type Pin = { pc: number; cOctave: number }

export type TunerFrame = {
  reading: PitchReading | null
  level: number
  trace: (number | null)[]
}

type EngineListener = (frame: TunerFrame) => void

class TunerEngine {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private buffer: Float32Array<ArrayBuffer> | null = null
  private master: GainNode | null = null
  private partials: OscillatorNode[] = []
  private raf = 0
  private listening = false
  private opening: Promise<void> | null = null
  private toneHz = A4_HZ
  private referenceHz = A4_HZ
  private edo: Edo = 36
  private lastLevel = 0
  private lastAnalysis = 0
  private lastHeardAt = 0
  private stable: PitchReading | null = null
  private candidateKey = ''
  private candidateCount = 0
  private window: number[] = []
  private trace: (number | null)[] = Array.from({ length: TRACE_LENGTH }, () => null)

  private readonly onFrame: EngineListener

  constructor(onFrame: EngineListener) {
    this.onFrame = onFrame
  }

  async startMic(): Promise<void> {
    if (this.listening) return
    if (this.opening) return this.opening
    this.opening = this.openMic().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private async openMic(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot use a microphone here.')
    }
    await this.ensureContext()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    })
    const ctx = this.ctx!
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0
    const source = ctx.createMediaStreamSource(stream)
    source.connect(analyser)
    this.stream = stream
    this.source = source
    this.analyser = analyser
    this.buffer = new Float32Array(analyser.fftSize)
    this.listening = true
    this.lastAnalysis = 0
    this.loop()
  }

  stopMic(): void {
    this.listening = false
    cancelAnimationFrame(this.raf)
    this.stream?.getTracks().forEach((track) => track.stop())
    this.source?.disconnect()
    this.stream = null
    this.source = null
    this.analyser = null
    this.buffer = null
    this.stable = null
    this.window = []
    this.candidateCount = 0
    this.candidateKey = ''
    this.trace = Array.from({ length: TRACE_LENGTH }, () => null)
    this.emit(null, 0)
  }

  async setToneOn(on: boolean): Promise<void> {
    await this.ensureContext()
    this.ensurePartials()
    this.applyToneHz()
    const ctx = this.ctx!
    const gain = this.master!
    const now = ctx.currentTime
    gain.gain.cancelScheduledValues(now)
    gain.gain.setTargetAtTime(on ? 1 : 0, now, on ? 0.02 : 0.04)
  }

  setToneHz(hz: number): void {
    if (!Number.isFinite(hz) || hz <= 0) return
    this.toneHz = hz
    this.applyToneHz()
  }

  setTuning(a4Hz: number, edo: Edo): void {
    const edoChanged = edo !== this.edo
    this.referenceHz = a4Hz
    this.edo = edo
    if (edoChanged) {
      this.trace = Array.from({ length: TRACE_LENGTH }, () => null)
      this.candidateKey = ''
      this.candidateCount = 0
      this.window = []
    }
    if (this.stable) this.stable = describeFrequency(this.stable.heardHz, a4Hz, edo)
    if (edoChanged || this.stable) this.emit(this.stable, this.lastLevel)
  }

  dispose(): void {
    this.stopMic()
    const now = this.ctx?.currentTime ?? 0
    for (const osc of this.partials) {
      try {
        osc.stop(now)
      } catch {
        // already stopped
      }
      osc.disconnect()
    }
    this.partials = []
    this.master?.disconnect()
    void this.ctx?.close()
    this.ctx = null
    this.master = null
  }

  private async ensureContext(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0
      this.master.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume()
  }

  private ensurePartials(): void {
    if (!this.ctx || !this.master || this.partials.length > 0) return
    const gains = [0.14, 0.05, 0.025]
    this.partials = gains.map((level, index) => {
      const osc = this.ctx!.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = this.toneHz * (index + 1)
      const gain = this.ctx!.createGain()
      gain.gain.value = level
      osc.connect(gain)
      gain.connect(this.master!)
      osc.start()
      return osc
    })
  }

  private applyToneHz(): void {
    if (!this.ctx || this.partials.length === 0) return
    const now = this.ctx.currentTime
    this.partials.forEach((osc, index) => {
      osc.frequency.setTargetAtTime(this.toneHz * (index + 1), now, 0.015)
    })
  }

  private loop = (): void => {
    if (!this.listening) return
    this.raf = requestAnimationFrame(this.loop)
    const now = performance.now()
    if (now - this.lastAnalysis < ANALYSIS_INTERVAL_MS) return
    this.lastAnalysis = now
    const analyser = this.analyser
    const buffer = this.buffer
    const ctx = this.ctx
    if (!analyser || !buffer || !ctx) return

    analyser.getFloatTimeDomainData(buffer)
    const level = rms(buffer)
    if (level < SILENCE_RMS) {
      if (now - this.lastHeardAt > SILENCE_HOLD_MS) {
        this.stable = null
        this.window = []
        this.candidateKey = ''
        this.candidateCount = 0
        this.pushTrace(null)
        this.emit(null, level)
      } else {
        this.pushTrace(this.stable?.cents ?? null)
        this.emit(this.stable, level)
      }
      return
    }

    const hz = detectPitch(buffer, ctx.sampleRate)
    if (hz == null) {
      this.pushTrace(this.stable?.cents ?? null)
      this.emit(this.stable, level)
      return
    }

    this.lastHeardAt = now
    const reading = this.accept(hz)
    this.pushTrace(reading.cents)
    this.emit(reading, level)
  }

  /** Keep the current note until a new one has shown up on two analyses, then median-smooth. */
  private accept(hz: number): PitchReading {
    const immediate = describeFrequency(hz, this.referenceHz, this.edo)
    const key = `${immediate.pitchClass}:${immediate.octave}`
    if (key !== this.candidateKey) {
      this.candidateKey = key
      this.candidateCount = 1
      this.window = [hz]
    } else {
      this.candidateCount += 1
      this.window.push(hz)
      if (this.window.length > 5) this.window.shift()
    }

    if (!this.stable || this.candidateCount >= 2) {
      const sorted = [...this.window].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]
      this.stable = describeFrequency(median, this.referenceHz, this.edo)
    }
    return this.stable
  }

  private pushTrace(cents: number | null): void {
    this.trace.push(cents)
    if (this.trace.length > TRACE_LENGTH) this.trace.shift()
  }

  private emit(reading: PitchReading | null, level: number): void {
    this.lastLevel = level
    this.onFrame({
      reading,
      level,
      trace: this.trace.slice(),
    })
  }
}

function micErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Microphone permission is blocked. Allow the mic for this page, then try again.'
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return 'No microphone was found.'
  }
  if (error instanceof Error && error.message) return error.message
  return 'The microphone could not be opened.'
}

const EMPTY_TRACE: (number | null)[] = Array.from({ length: TRACE_LENGTH }, () => null)

export function useTuner(a4Hz: number, edo: Edo) {
  const engineRef = useRef<TunerEngine | null>(null)
  const a4Ref = useRef(a4Hz)
  const edoRef = useRef(edo)
  const [frame, setFrame] = useState<TunerFrame>({
    reading: null,
    level: 0,
    trace: EMPTY_TRACE,
  })
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toneOn, setToneOn] = useState(false)
  const [pin, setPin] = useState<Pin | null>(null)
  const [cOctave, setCOctave] = useState(4)

  useEffect(() => {
    const engine = new TunerEngine(setFrame)
    engine.setTuning(a4Ref.current, edoRef.current)
    engineRef.current = engine
    return () => {
      engine.dispose()
      engineRef.current = null
    }
  }, [])

  useEffect(() => {
    engineRef.current?.setTuning(a4Hz, edo)
  }, [a4Hz, edo])

  const setToneHz = useCallback((hz: number) => {
    engineRef.current?.setToneHz(hz)
  }, [])

  async function start() {
    setError(null)
    try {
      await engineRef.current?.startMic()
      setListening(true)
    } catch (error) {
      setListening(false)
      setError(micErrorMessage(error))
    }
  }

  function stop() {
    engineRef.current?.stopMic()
    setListening(false)
    setFrame({ reading: null, level: 0, trace: EMPTY_TRACE })
  }

  async function toggleTone() {
    const next = !toneOn
    setToneOn(next)
    await engineRef.current?.setToneOn(next)
  }

  function selectPitch(pc: number) {
    const release = pin?.pc === pc && pin.cOctave === cOctave
    setPin(release ? null : { pc, cOctave })
    if (!release) engineRef.current?.setToneHz(spellPitchClass(pc, cOctave, a4Hz, edo).hz)
    setToneOn(true)
    void engineRef.current?.setToneOn(true)
  }

  function changeOctave(next: number) {
    const octave = Math.min(6, Math.max(3, next))
    setCOctave(octave)
    setPin((current) => (current ? { ...current, cOctave: octave } : current))
    if (pin) engineRef.current?.setToneHz(spellPitchClass(pin.pc, octave, a4Hz, edo).hz)
  }

  function adoptEdo(next: Edo) {
    setPin((current) => {
      if (!current || next === edo) return current
      return { ...current, pc: remapPitchClass(current.pc, edo, next) }
    })
  }

  return {
    frame,
    listening,
    error,
    toneOn,
    pin,
    cOctave,
    start,
    stop,
    toggleTone,
    selectPitch,
    changeOctave,
    adoptEdo,
    setToneHz,
  }
}
