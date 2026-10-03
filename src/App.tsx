import { useEffect, useState } from 'react'
import {
  A4_CHOICES,
  EDO_CHOICES,
  a4PitchClass,
  chromaticLabel,
  formatCents,
  formatStepCents,
  halfStepCents,
  intonationWord,
  isEdo,
  pitchLabel,
  readStoredA4,
  readStoredEdo,
  spellPitchClass,
  storeA4,
  storeEdo,
  type Edo,
  type PitchReading,
} from './edo'
import { useTuner } from './useTuner'
import './App.css'

const OCTAVE_MIN = 3
const OCTAVE_MAX = 6

function place(pitchClass: number, radius: number, edo: Edo): { left: string; top: string } {
  const angle = ((pitchClass - a4PitchClass(edo)) / edo) * Math.PI * 2 - Math.PI / 2
  return {
    left: `${50 + Math.cos(angle) * radius}%`,
    top: `${50 + Math.sin(angle) * radius}%`,
  }
}

function idlePitchText(edo: Edo): string {
  if (edo === 12) return 'The nearest semitone appears here.'
  if (edo === 24) return 'The nearest quarter-tone appears here.'
  return 'The nearest third-tone appears here.'
}

function compassHint(edo: Edo): string {
  if (edo === 12) return 'Twelve equal semitones. A sits at the top.'
  if (edo === 24) {
    return '↑ raises by one quarter-tone. Brighter marks are the chromatic notes. A sits at the top.'
  }
  return '↑ raises by one step, ↓ lowers by one step. Brighter marks are the usual chromatic notes. A sits at the top.'
}

function markColor(cents: number): string {
  const abs = Math.abs(cents)
  if (abs < 5) return 'var(--in-tune)'
  if (cents < 0) return 'var(--flat)'
  return 'var(--sharp)'
}

export default function App() {
  const [a4Hz, setA4Hz] = useState(readStoredA4)
  const [edo, setEdo] = useState(readStoredEdo)
  const tuner = useTuner(a4Hz, edo)
  const { frame, listening, error, toneOn, pin, cOctave, setToneHz } = tuner
  const reading = frame.reading
  const halfStep = halfStepCents(edo)

  const tonePitch = pin
    ? spellPitchClass(pin.pc, pin.cOctave, a4Hz, edo)
    : reading
      ? spellPitchClass(reading.pitchClass, reading.cOctave, a4Hz, edo)
      : spellPitchClass(a4PitchClass(edo), 4, a4Hz, edo)

  useEffect(() => {
    setToneHz(tonePitch.hz)
  }, [tonePitch.hz, setToneHz])

  useEffect(() => {
    document.title = `Oboe tuner · ${edo}-EDO`
  }, [edo])

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
          <h1>{edo}-EDO tuner</h1>
        </div>
        <div className="tuning">
          <div className="reference-row">
            <select
              value={edo}
              aria-label="Equal divisions of the octave"
              onChange={(event) => {
                const next = Number(event.target.value)
                if (!isEdo(next)) return
                tuner.adoptEdo(next)
                setEdo(next)
                storeEdo(next)
              }}
            >
              {EDO_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}-EDO
                </option>
              ))}
            </select>
            <label className="a4-field">
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
            </label>
          </div>
          <span className="reference-note">one step = {formatStepCents(edo)}¢</span>
        </div>
      </header>

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <div className="stage">
        <section
          className={reading && Math.abs(reading.cents) < 5 ? 'panel in-tune' : 'panel'}
          aria-label="Pitch"
        >
          <Readout reading={reading} dim={!reading} edo={edo} halfStep={halfStep} />
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
              idlePitchText(edo)
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
              <span>{edo}</span>
              <small>equal</small>
            </div>
            {Array.from({ length: edo }, (_, pc) => {
              const spelled = spellPitchClass(pc, cOctave, a4Hz, edo)
              const label = chromaticLabel(pc, edo)
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
                  style={place(pc, 34, edo)}
                  aria-label={pitchLabel(spelled)}
                  aria-pressed={held}
                  onClick={() => tuner.selectPitch(pc)}
                />
              )
            })}
            {Array.from({ length: edo }, (_, pc) => {
              const label = chromaticLabel(pc, edo)
              if (!label) return null
              return (
                <span key={label} className="compass-label" style={place(pc, 44, edo)}>
                  {label}
                </span>
              )
            })}
          </div>
          <p className="hint">{compassHint(edo)}</p>
        </section>
      </div>

      <section className="panel trace-panel" aria-label="Steadiness">
        <div className="panel-head">
          <h2>Steadiness</h2>
          <span className="trace-scale">±5¢ in the band</span>
        </div>
        <Trace samples={frame.trace} halfStep={halfStep} />
      </section>
    </div>
  )
}

function Readout({
  reading,
  dim,
  edo,
  halfStep,
}: {
  reading: PitchReading | null
  dim: boolean
  edo: Edo
  halfStep: number
}) {
  const needle = reading
    ? Math.min(100, Math.max(0, ((reading.cents + halfStep) / (halfStep * 2)) * 100))
    : 50
  const zone = (10 / (halfStep * 2)) * 100
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
        aria-valuemin={-halfStep}
        aria-valuemax={halfStep}
        aria-valuenow={reading ? Number(reading.cents.toFixed(1)) : 0}
        aria-label={`Cents from the nearest ${edo}-EDO pitch`}
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

function Trace({ samples, halfStep }: { samples: (number | null)[]; halfStep: number }) {
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
    const y = mid - (Math.max(-halfStep, Math.min(halfStep, cents)) / halfStep) * reach
    path += `${path ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`
  })
  if (path) paths.push(path)
  const band = (5 / halfStep) * reach

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
