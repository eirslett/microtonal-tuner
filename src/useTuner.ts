import { useCallback, useEffect, useRef, useState } from 'react'
import {
  A4_HZ,
  describeFrequency,
  remapPitchClass,
  spellPitchClass,
  type Edo,
  type PitchReading,
} from './edo'
import { CrepePitch, SampleRing, crepeWindowLength } from './crepe'
import { detectPitch, rms, type PitchAlgorithm } from './pitch'

const TRACE_LENGTH = 96
const ANALYSIS_INTERVAL_MS = 45
const SILENCE_HOLD_MS = 220
const SILENCE_RMS = 0.008
// iPad's raw mic, with speech processing off, is much quieter than a laptop mic.
const IOS_SILENCE_RMS = 0.0004
const IOS_METER_GAIN = 16

function isIosDevice(): boolean {
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

type WebAudioSessionType = 'auto' | 'playback' | 'play-and-record' | 'ambient' | 'transient' | 'transient-solo'
type WebAudioSessionState = 'inactive' | 'active' | 'interrupted'

type WebAudioSession = EventTarget & {
  type: WebAudioSessionType
  readonly state: WebAudioSessionState
}

function webAudioSession(): WebAudioSession | null {
  const session = (navigator as Navigator & { audioSession?: WebAudioSession }).audioSession
  return session ?? null
}

function preferAudioSession(type: 'playback' | 'play-and-record'): void {
  const session = webAudioSession()
  if (!session || session.type === type) return
  if (type === 'playback' && session.type === 'play-and-record') return
  try {
    session.type = type
  } catch {
    // Safari only allows a session change during a user gesture.
  }
}

function silentWavUrl(): string {
  const samples = 16
  const dataSize = samples * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true)
  view.setUint32(28, 16000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, dataSize, true)
  let binary = ''
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
  return `data:audio/wav;base64,${btoa(binary)}`
}

export type Pin = { pc: number; cOctave: number }

export type TunerFrame = {
  reading: PitchReading | null
  level: number
  trace: (number | null)[]
}

type EngineListener = (frame: TunerFrame) => void

type DeviceStop = { tone: boolean; mic: boolean }

class TunerEngine {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private buffer: Float32Array<ArrayBuffer> | null = null
  private master: GainNode | null = null
  private partials: OscillatorNode[] = []
  private partialGains: GainNode[] = []
  private raf = 0
  private listening = false
  private opening: Promise<void> | null = null
  private toneWanted = false
  private speaker: HTMLAudioElement | null = null
  private speakerPlay: Promise<void> | null = null
  private outputWatched = false
  private disposed = false
  private toneHz = A4_HZ
  private referenceHz = A4_HZ
  private edo: Edo = 36
  private algorithm: PitchAlgorithm = 'crepe'
  private captureGeneration = 0
  private noiseFloor = SILENCE_RMS
  private meterGain = 1
  private capture: AudioWorkletNode | null = null
  private captureMute: GainNode | null = null
  private readonly ring = new SampleRing()
  private crepe: CrepePitch | null = null
  private crepeBusy = false
  private crepeFailed = false
  private crepeToken = 0
  private lastLevel = 0
  private lastAnalysis = 0
  private lastHeardAt = 0
  private stable: PitchReading | null = null
  private candidateKey = ''
  private candidateCount = 0
  private window: number[] = []
  private trace: (number | null)[] = Array.from({ length: TRACE_LENGTH }, () => null)

  private readonly onFrame: EngineListener
  private readonly onDeviceStop: (stop: DeviceStop) => void
  private readonly onError: (message: string) => void

  constructor(
    onFrame: EngineListener,
    onDeviceStop: (stop: DeviceStop) => void,
    onError: (message: string) => void,
  ) {
    this.onFrame = onFrame
    this.onDeviceStop = onDeviceStop
    this.onError = onError
  }

  async startMic(): Promise<boolean> {
    if (this.listening) return true
    if (this.opening) {
      await this.opening
      return this.listening
    }
    this.opening = this.openMic().finally(() => {
      this.opening = null
    })
    await this.opening
    return this.listening
  }

  private async openMic(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot use a microphone here.')
    }
    this.beginOutput('play-and-record')
    const ios = isIosDevice()
    this.noiseFloor = ios ? IOS_SILENCE_RMS : SILENCE_RMS
    this.meterGain = ios ? IOS_METER_GAIN : 1
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        // iPad leaves the raw mic very quiet unless automatic gain is allowed.
        autoGainControl: ios,
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
    for (const track of stream.getTracks()) {
      track.contentHint = 'music'
      track.addEventListener('ended', this.onTrackEnded)
    }
    while (
      !this.disposed &&
      this.source === source &&
      this.algorithm === 'crepe' &&
      !this.capture &&
      !this.crepeFailed
    ) {
      await this.enableCrepe(ctx, source)
    }
    if (this.disposed || this.source !== source) return
    if (this.algorithm !== 'crepe') this.stopCapture()
    this.listening = true
    this.lastAnalysis = 0
    this.loop()
  }

  setAlgorithm(algorithm: PitchAlgorithm): void {
    if (algorithm === this.algorithm) return
    this.algorithm = algorithm
    this.candidateKey = ''
    this.candidateCount = 0
    this.window = []
    if (algorithm === 'yin') {
      this.captureGeneration += 1
      this.stopCapture()
      return
    }
    const ctx = this.ctx
    const source = this.source
    if (!this.listening || !ctx || !source) return
    void this.enableCrepe(ctx, source)
  }

  private async enableCrepe(ctx: AudioContext, source: MediaStreamAudioSourceNode): Promise<void> {
    const generation = ++this.captureGeneration
    this.crepeFailed = false
    try {
      await ctx.audioWorklet.addModule(new URL('./mic-capture-processor.js', import.meta.url))
      if (this.captureStale(generation, source)) return
      const capture = new AudioWorkletNode(ctx, 'mic-capture')
      capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (event.data instanceof Float32Array) this.ring.push(event.data)
      }
      const mute = ctx.createGain()
      mute.gain.value = 0
      source.connect(capture)
      capture.connect(mute)
      mute.connect(ctx.destination)
      if (this.captureStale(generation, source)) {
        capture.port.close()
        capture.disconnect()
        mute.disconnect()
        return
      }
      this.capture = capture
      this.captureMute = mute
      this.crepe ??= new CrepePitch()
      void this.crepe.load().catch((error: unknown) => {
        if (generation !== this.captureGeneration || this.disposed || this.crepeFailed) return
        this.crepeFailed = true
        this.onError(error instanceof Error ? error.message : 'The pitch model could not be loaded.')
      })
    } catch (error) {
      if (this.captureStale(generation, source)) return
      this.crepeFailed = true
      this.onError(error instanceof Error ? error.message : 'The pitch model could not be loaded.')
    }
  }

  private captureStale(generation: number, source: MediaStreamAudioSourceNode): boolean {
    return (
      generation !== this.captureGeneration ||
      this.algorithm !== 'crepe' ||
      this.disposed ||
      this.source !== source
    )
  }

  private stopCapture(): void {
    this.crepeToken += 1
    this.crepeBusy = false
    this.capture?.port.close()
    this.capture?.disconnect()
    this.captureMute?.disconnect()
    this.capture = null
    this.captureMute = null
    this.ring.clear()
  }

  stopMic(): void {
    this.listening = false
    cancelAnimationFrame(this.raf)
    this.stopCapture()
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
    this.toneWanted = on
    if (!on) {
      this.setMasterGain(false)
      this.publishPlayback(false)
      return
    }
    // iPad will not audibly start Web Audio until this tap also opens the
    // media session. Do that before any await, or the gesture is gone.
    this.beginOutput(this.listening ? 'play-and-record' : 'playback')
    const wasRunning = this.ctx?.state === 'running'
    this.ensurePartials()
    this.applyToneHz()
    this.setMasterGain(true)
    this.publishPlayback(true)
    if (wasRunning) return
    await this.finishUnlock()
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
    this.disposed = true
    this.toneWanted = false
    this.ctx?.removeEventListener('statechange', this.onContextState)
    webAudioSession()?.removeEventListener('statechange', this.onSessionState)
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
    for (const gain of this.partialGains) gain.disconnect()
    this.partialGains = []
    this.speaker?.pause()
    this.speaker = null
    this.speakerPlay = null
    this.master?.disconnect()
    void this.ctx?.close()
    this.ctx = null
    this.master = null
  }

  private beginOutput(session: 'playback' | 'play-and-record'): void {
    preferAudioSession(session)
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0
      this.master.connect(this.ctx.destination)
    }
    if (this.ctx.state !== 'running') void this.ctx.resume()
    this.watchOutput()
    this.playSilentPulse()
    this.blip()
  }

  private watchOutput(): void {
    if (this.outputWatched || !this.ctx) return
    this.outputWatched = true
    this.ctx.addEventListener('statechange', this.onContextState)
    webAudioSession()?.addEventListener('statechange', this.onSessionState)
    this.watchMediaKeys()
  }

  private watchMediaKeys(): void {
    const session = navigator.mediaSession
    if (!session) return
    try {
      session.metadata = new MediaMetadata({ title: 'Oboe tuner' })
    } catch {
      // Metadata is optional. The pause handler is what updates the UI.
    }
    for (const action of ['pause', 'stop'] as const) {
      try {
        session.setActionHandler(action, () => this.noteExternalStop('tone'))
      } catch {
        // This action is not available in the browser.
      }
    }
  }

  private publishPlayback(playing: boolean): void {
    const session = navigator.mediaSession
    if (!session) return
    try {
      session.playbackState = playing ? 'playing' : 'none'
    } catch {
      // Ignore an unsupported playback state.
    }
  }

  private onContextState = (): void => {
    const state = this.ctx?.state as string | undefined
    if (state === 'interrupted') this.noteExternalStop('tone')
  }

  private onSessionState = (): void => {
    if (webAudioSession()?.state === 'interrupted') this.noteExternalStop('all')
  }

  private onTrackEnded = (): void => {
    if (!this.listening || this.disposed) return
    this.stopMic()
    this.onDeviceStop({ tone: false, mic: true })
  }

  private noteExternalStop(scope: 'tone' | 'all'): void {
    if (this.disposed) return
    const tone = this.toneWanted
    const mic = scope === 'all' && this.listening
    if (!tone && !mic) return
    if (tone) {
      this.toneWanted = false
      try {
        this.setMasterGain(false)
      } catch {
        // The context may already be interrupted.
      }
      try {
        this.speaker?.pause()
      } catch {
        // The system already paused it.
      }
      this.publishPlayback(false)
    }
    if (mic) this.stopMic()
    this.onDeviceStop({ tone, mic })
  }

  private playSilentPulse(): void {
    if (!this.speaker) {
      const speaker = new Audio(silentWavUrl())
      speaker.preload = 'auto'
      speaker.setAttribute('playsinline', '')
      this.speaker = speaker
    }
    const speaker = this.speaker
    try {
      speaker.currentTime = 0
    } catch {
      // Metadata may not be ready yet. play() still counts as the gesture.
    }
    this.speakerPlay = speaker.play().then(
      () => undefined,
      () => undefined,
    )
  }

  private blip(): void {
    const ctx = this.ctx
    if (!ctx) return
    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    try {
      source.start()
    } catch {
      // The context can already be closed.
    }
  }

  private async finishUnlock(): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    await this.speakerPlay
    try {
      if (ctx.state !== 'running') await ctx.resume()
    } catch {
      // The silent clip may already have opened the session.
    }
    if (!this.toneWanted || ctx.state !== 'running') return
    // Oscillators started while the context was still suspended stay silent on iPad.
    this.restartPartials()
    this.applyToneHz()
    this.setMasterGain(true)
  }

  private setMasterGain(on: boolean): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return
    const now = ctx.currentTime
    const gain = master.gain
    gain.cancelScheduledValues(now)
    if (ctx.state === 'running') {
      gain.setTargetAtTime(on ? 1 : 0, now, on ? 0.02 : 0.04)
      return
    }
    gain.setValueAtTime(on ? 1 : 0, now)
  }

  private restartPartials(): void {
    const now = this.ctx?.currentTime ?? 0
    for (const osc of this.partials) {
      try {
        osc.stop(now)
      } catch {
        // already stopped
      }
      osc.disconnect()
    }
    for (const gain of this.partialGains) gain.disconnect()
    this.partials = []
    this.partialGains = []
    this.ensurePartials()
  }

  private ensurePartials(): void {
    if (!this.ctx || !this.master || this.partials.length > 0) return
    const levels = [0.14, 0.05, 0.025]
    this.partials = levels.map((level, index) => {
      const osc = this.ctx!.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = this.toneHz * (index + 1)
      const gain = this.ctx!.createGain()
      gain.gain.value = level
      osc.connect(gain)
      gain.connect(this.master!)
      osc.start()
      this.partialGains.push(gain)
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
    const shown = Math.min(1, level * this.meterGain)
    if (level < this.noiseFloor) {
      if (now - this.lastHeardAt > SILENCE_HOLD_MS) {
        this.stable = null
        this.window = []
        this.candidateKey = ''
        this.candidateCount = 0
        this.pushTrace(null)
        this.emit(null, shown)
      } else {
        this.pushTrace(this.stable?.cents ?? null)
        this.emit(this.stable, shown)
      }
      return
    }

    if (this.algorithm === 'crepe') {
      this.pushTrace(this.stable?.cents ?? null)
      this.emit(this.stable, shown)
      this.queueCrepe(ctx.sampleRate)
      return
    }

    const hz = detectPitch(buffer, ctx.sampleRate)
    if (hz == null) {
      this.pushTrace(this.stable?.cents ?? null)
      this.emit(this.stable, shown)
      return
    }

    this.lastHeardAt = now
    const reading = this.accept(hz)
    this.pushTrace(reading.cents)
    this.emit(reading, shown)
  }

  private queueCrepe(sampleRate: number): void {
    if (this.crepeBusy || this.crepeFailed || !this.crepe) return
    const samples = this.ring.latest(crepeWindowLength(sampleRate))
    if (!samples) return
    const token = this.crepeToken
    this.crepeBusy = true
    void this.crepe
      .detect(samples, sampleRate)
      .then((hz) => {
        if (token !== this.crepeToken || !this.listening || hz == null) return
        this.lastHeardAt = performance.now()
        const reading = this.accept(hz)
        this.pushTrace(reading.cents)
        this.emit(reading, this.lastLevel)
      })
      .catch((error: unknown) => {
        if (token !== this.crepeToken || this.crepeFailed) return
        this.crepeFailed = true
        this.onError(error instanceof Error ? error.message : 'Pitch detection failed.')
      })
      .finally(() => {
        if (token === this.crepeToken) this.crepeBusy = false
      })
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

export function useTuner(a4Hz: number, edo: Edo, algorithm: PitchAlgorithm) {
  const engineRef = useRef<TunerEngine | null>(null)
  const a4Ref = useRef(a4Hz)
  const edoRef = useRef(edo)
  const algorithmRef = useRef(algorithm)
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
  const [appliedAlgorithm, setAppliedAlgorithm] = useState(algorithm)
  if (algorithm !== appliedAlgorithm) {
    setAppliedAlgorithm(algorithm)
    setError(null)
  }

  useEffect(() => {
    const engine = new TunerEngine(
      setFrame,
      ({ tone, mic }) => {
        if (tone) setToneOn(false)
        if (mic) setListening(false)
      },
      setError,
    )
    engine.setTuning(a4Ref.current, edoRef.current)
    engine.setAlgorithm(algorithmRef.current)
    engineRef.current = engine
    return () => {
      engine.dispose()
      engineRef.current = null
    }
  }, [])

  useEffect(() => {
    engineRef.current?.setTuning(a4Hz, edo)
  }, [a4Hz, edo])

  useEffect(() => {
    engineRef.current?.setAlgorithm(algorithm)
  }, [algorithm])

  const setToneHz = useCallback((hz: number) => {
    engineRef.current?.setToneHz(hz)
  }, [])

  async function start() {
    setError(null)
    try {
      const started = await engineRef.current?.startMic()
      if (started) setListening(true)
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
