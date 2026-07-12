import type { JSX, ReactNode } from 'react'

interface SettingsGroupProps {
  title?: string
  children: ReactNode
}

interface SettingsRowProps {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
}

interface SettingsSwitchProps {
  checked: boolean
  label: string
  disabled?: boolean
  onChange: (checked: boolean) => void
}

export function SettingsGroup({ title, children }: SettingsGroupProps): JSX.Element {
  return (
    <section className="settings-group">
      {title && <h3>{title}</h3>}
      <div className="settings-list">{children}</div>
    </section>
  )
}

export function SettingsRow({ title, description, children }: SettingsRowProps): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <strong>{title}</strong>
        {description && <span>{description}</span>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  )
}

export function SettingsSwitch({ checked, label, disabled, onChange }: SettingsSwitchProps): JSX.Element {
  return (
    <label className="settings-switch">
      <span className="settings-visually-hidden">{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span aria-hidden="true"><span /></span>
    </label>
  )
}
