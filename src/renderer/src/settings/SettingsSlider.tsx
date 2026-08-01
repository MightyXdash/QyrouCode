import type { CSSProperties, JSX } from 'react'

interface SettingsSliderProps {
  value: number
  min: number
  max: number
  step: number
  label: string
  ticks?: readonly number[]
  onChange: (value: number) => void
}

const formatTokens = (value: number): string => `${Math.round(value / 1000)}K`

export default function SettingsSlider({ value, min, max, step, label, ticks, onChange }: SettingsSliderProps): JSX.Element {
  const position = (target: number): number => ((target - min) / (max - min)) * 100
  return (
    <div className="settings-slider">
      <div className="settings-slider-header">
        <span>{formatTokens(min)}</span>
        <strong aria-hidden="true">{formatTokens(value)}</strong>
        <span>{formatTokens(max)}</span>
      </div>
      <input
        type="range"
        aria-label={label}
        aria-valuetext={`${formatTokens(value)} tokens`}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ '--settings-slider-progress': `${position(value)}%` } as CSSProperties}
      />
      {ticks && (
        <div className="settings-slider-ticks" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick} className={tick === value ? 'active' : ''} style={{ left: `${position(tick)}%` }} />
          ))}
        </div>
      )}
    </div>
  )
}
