import { useEffect, useState } from 'react'
import {
  A4_CHOICES,
  HALF_STEP_CENTS,
  chromaticLabel,
  formatCents,
  intonationWord,
  pitchLabel,
  readStoredA4,
  spellPitchClass,
  storeA4,
  type PitchReading,
} from './edo'
import { useTuner } from './useTuner'
import './App.css'

const OCTAVE_MIN = 3
const OCTAVE_MAX = 6

function place(pitchClass: number, radius: number): { left: string; top: string } {
  const angle = ((pitchClass - 27) / 36) * Math.PI * 2 - Math.PI / 2
  return {
    left: `${50 + Math.cos(angle) * radius}%`,
    top: `${50 + Math.sin(angle) * radius}%`,
  }
}

function markColor(cents: number): string {
  const abs = Math.abs(cents)
  if (abs < 5) return 'var(--in-tune)'
  if (cents < 0) return 'var(--flat)'
  return 'var(--sharp)'
}

export default function App() {
  const [a4Hz, setA4Hz] = useState(readStoredA4)
  const tuner = useTuner(a4Hz)
  const { frame, listening, error, toneOn, pin, cOctave, setToneHz } = tuner
  const reading = frame.reading

  const tonePitch = pin
    ? spellPitchClass(pin.pc, pin.cOctave, a4Hz)
    : reading
      ? spellPitchClass(reading.pitchClass, reading.cOctave, a4Hz)
      : spellPitchClass(27, 4, a4Hz)

  useEffect(() => {
    setToneHz(tonePitch.hz)
  }, [tonePitch.hz, setToneHz])

  const announcement = error
    ? error
    : !listening
      ? ''
      : !reading
        ? 'Listening'
        : `${pitchLabel(reading)}, ${intonationWord(reading.cents)}`

  const status = error
    ? error
    : !listening
      ? 'Listen, then play.'
      : reading
        ? intonationWord(reading.cents)
        : 'Listening'

  return (
    <div className="app">
      <header className="top">
        <div>
          <p className="eyebrow">Oboe</p>
          <h1>36-EDO tuner</h1>
        </div>
        <label className="reference">
          <span className="reference-row">
            A<sub>4</sub>
            <select
              value={a4Hz}
              aria-label="Concert A in hertz"
              onChange={(event) => {
                const hz = Number(event.target.value)
                setA4Hz(hz)
                storeA4(hz)
              }}
            >
              {A4_CHOICES.map((hz) => (
                <option key={hz} value={hz}>
                  {hz} Hz
                </option>
              ))}
            </select>
          </span>
          <span className="reference-note">one step = 33.3¢</span>
        </label>
      </header>

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <div className="stage">
        <section
          className={reading && Math.abs(reading.cents) < 5 ? 'panel in-tune' : 'panel'}
          aria-label="Pitch"
        >
          <Readout reading={reading} dim={!reading} />
          <p className="status" style={reading ? { color: markColor(reading.cents) } : undefined}>
            {status}
          </p>
          <p className="freqs">
            {reading ? (
              <>
                Heard {reading.heardHz.toFixed(1)} Hz
                <span aria-hidden="true"> · </span>
                <span className="freq-target">in tune {reading.hz.toFixed(1)} Hz</span>
              </>
            ) : (
              'The nearest third-tone appears here.'
            )}
          </p>

          <div className="controls">
            <button
              type="button"
              className="button primary"
              aria-pressed={listening}
              onClick={() => (listening ? tuner.stop() : void tuner.start())}
            >
              <span className="level" aria-hidden="true">
                <span style={{ width: `${Math.min(100, (frame.level / 0.12) * 100)}%` }} />
              </span>
              {listening ? 'Stop' : 'Listen'}
            </button>
            <button
              type="button"
              className="button"
              aria-pressed={toneOn}
              onClick={() => void tuner.toggleTone()}
            >
              {toneOn ? 'Tone on' : 'Sound tone'}
              <span className="button-note">{pitchLabel(tonePitch)}</span>
            </button>
          </div>
          <p className="hint">
              {pin
              ? `Holding ${pitchLabel(tonePitch)}. Click it again to follow what you play. Use headphones.`
              : 'The tone follows the nearest in-tune pitch. Headphones keep it out of the mic.'}
          </p>
        </section>

        <section className="panel compass-panel" aria-label="Hold a pitch">
          <div className="panel-head">
            <h2>Hold a pitch</h2>
            <div className="stepper">
              <button
                type="button"
                onClick={() => tuner.changeOctave(cOctave - 1)}
                disabled={cOctave <= OCTAVE_MIN}
                aria-label="Lower octave"
              >
                −
              </button>
              <span>
                Octave <strong>{cOctave}</strong>
              </span>
              <button
                type="button"
                onClick={() => tuner.changeOctave(cOctave + 1)}
                disabled={cOctave >= OCTAVE_MAX}
                aria-label="Raise octave"
              >
                +
              </button>
            </div>
          </div>

          <div className="compass">
            <div className="compass-ring" />
            <div className="compass-center">
              <span>36</span>
              <small>equal</small>
            </div>
            {Array.from({ length: 36 }, (_, pc) => {
              const spelled = spellPitchClass(pc, cOctave, a4Hz)
              const label = chromaticLabel(pc)
              const held = pin?.pc === pc && pin.cOctave === cOctave
              const heard = reading?.pitchClass === pc
              return (
                <button
                  key={pc}
                  type="button"
                  className={
                    label
                      ? `tick chromatic${heard ? ' is-heard' : ''}${held ? ' is-held' : ''}`
                      : `tick${heard ? ' is-heard' : ''}${held ? ' is-held' : ''}`
                  }
                  style={place(pc, 34)}
                  aria-label={pitchLabel(spelled)}
                  aria-pressed={held}
                  onClick={() => tuner.selectPitch(pc)}
                />
              )
            })}
            {Array.from({ length: 36 }, (_, pc) => {
              const label = chromaticLabel(pc)
              if (!label) return null
              return (
                <span key={label} className="compass-label" style={place(pc, 44)}>
                  {label}
                </span>
              )
            })}
          </div>
          <p className="hint">
            ↑ raises by one step, ↓ lowers by one step. Brighter marks are the usual chromatic notes. A sits at the top.
          </p>
        </section>
      </div>

      <section className="panel trace-panel" aria-label="Steadiness">
        <div className="panel-head">
          <h2>Steadiness</h2>
          <span className="trace-scale">±5¢ in the band</span>
        </div>
        <Trace samples={frame.trace} />
      </section>
    </div>
  )
}

function Readout({ reading, dim }: { reading: PitchReading | null; dim: boolean }) {
  const needle = reading
    ? Math.min(100, Math.max(0, ((reading.cents + HALF_STEP_CENTS) / (HALF_STEP_CENTS * 2)) * 100))
    : 50
  const zone = (10 / (HALF_STEP_CENTS * 2)) * 100
  const color = reading ? markColor(reading.cents) : 'var(--muted)'

  return (
    <div className={dim ? 'readout is-empty' : 'readout'} style={{ '--mark': color } as React.CSSProperties}>
      {reading ? (
        <p className="note">
          <span className="arrow">{reading.arrow}</span>
          <span className="letter">{reading.name}</span>
          <span className="note-octave">{reading.octave}</span>
        </p>
      ) : (
        <p className="note">
          <span className="letter dash">–</span>
        </p>
      )}
      <p className="cents">
        {reading ? (
          <>
            {formatCents(reading.cents)}
            <span> ¢</span>
          </>
        ) : (
          '–'
        )}
      </p>
      <div
        className="meter"
        role="meter"
        aria-valuemin={-HALF_STEP_CENTS}
        aria-valuemax={HALF_STEP_CENTS}
        aria-valuenow={reading ? Number(reading.cents.toFixed(1)) : 0}
        aria-label="Cents from the nearest 36-EDO pitch"
      >
        <div className="meter-track">
          <div className="meter-zone" style={{ left: `${50 - zone / 2}%`, width: `${zone}%` }} />
          <div className="meter-center" />
          <div className="needle" style={{ left: `${needle}%` }} />
        </div>
        <div className="meter-labels">
          <span>flat</span>
          <span>0</span>
          <span>sharp</span>
        </div>
      </div>
    </div>
  )
}

function Trace({ samples }: { samples: (number | null)[] }) {
  const mid = 24
  const reach = 18
  const paths: string[] = []
  let path = ''
  samples.forEach((cents, index) => {
    if (cents == null || samples.length < 2) {
      if (path) paths.push(path)
      path = ''
      return
    }
    const x = (index / (samples.length - 1)) * 100
    const y = mid - (Math.max(-HALF_STEP_CENTS, Math.min(HALF_STEP_CENTS, cents)) / HALF_STEP_CENTS) * reach
    path += `${path ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`
  })
  if (path) paths.push(path)
  const band = (5 / HALF_STEP_CENTS) * reach

  return (
    <svg
      className="trace"
      viewBox="0 0 100 48"
      preserveAspectRatio="none"
      role="img"
      aria-label="Recent cents, centered on in tune"
    >
      <rect x="0" y={mid - band} width="100" height={band * 2} className="trace-band" />
      <line x1="0" y1={mid} x2="100" y2={mid} className="trace-zero" />
      {paths.map((d, index) => (
        <path key={index} d={d} className="trace-line" />
      ))}
    </svg>
  )
}
