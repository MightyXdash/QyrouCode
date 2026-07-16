import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

export interface SettingsSelectOption {
  value: string
  label: string
  detail?: string
  disabled?: boolean
}

interface SettingsSelectProps {
  value: string
  options: readonly SettingsSelectOption[]
  label: string
  placeholder?: string
  disabled?: boolean
  compact?: boolean
  onChange: (value: string) => void
}

interface MenuPosition extends CSSProperties {
  '--settings-select-menu-max-height': string
  left: number
  top: number
  width: number
}

const MENU_MAX_HEIGHT = 238
const MENU_MIN_HEIGHT = 80
const MENU_BORDER_OVERLAP = 1
const MENU_ANIMATION_DURATION_MS = 300
const MENU_ANIMATION_FALLBACK_MS = MENU_ANIMATION_DURATION_MS + 100
const VIEWPORT_INSET = 12

export default function SettingsSelect({
  value,
  options,
  label,
  placeholder = 'Choose an option',
  disabled,
  compact,
  onChange
}: SettingsSelectProps): JSX.Element {
  const listboxId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const openFrameRef = useRef<number | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closingRef = useRef(false)
  const [open, setOpen] = useState(false)
  const [rendered, setRendered] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const selectedOption = options.find((option) => option.value === value)

  const finishClose = (): void => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
    closingRef.current = false
    setRendered(false)
    setPosition(null)
  }

  const placeMenu = (): void => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_INSET
    const maxHeight = Math.min(MENU_MAX_HEIGHT, Math.max(MENU_MIN_HEIGHT, spaceBelow + MENU_BORDER_OVERLAP))
    setPosition({
      '--settings-select-menu-max-height': `${maxHeight}px`,
      left: Math.min(rect.left, window.innerWidth - rect.width - VIEWPORT_INSET),
      top: rect.bottom - MENU_BORDER_OVERLAP,
      width: rect.width,
    })
  }

  const closeMenu = (): void => {
    if (openFrameRef.current !== null) cancelAnimationFrame(openFrameRef.current)
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    openFrameRef.current = null
    closingRef.current = true
    setOpen(false)
    closeTimerRef.current = setTimeout(finishClose, MENU_ANIMATION_FALLBACK_MS)
  }

  const openMenu = (preferredIndex?: number): void => {
    if (disabled || options.length === 0) return
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    if (openFrameRef.current !== null) cancelAnimationFrame(openFrameRef.current)
    closingRef.current = false
    placeMenu()
    const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled)
    setActiveIndex(preferredIndex ?? (selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled)))
    setRendered(true)
    openFrameRef.current = requestAnimationFrame(() => {
      openFrameRef.current = requestAnimationFrame(() => {
        setOpen(true)
        openFrameRef.current = null
      })
    })
  }

  const choose = (option: SettingsSelectOption): void => {
    if (option.disabled) return
    onChange(option.value)
    closeMenu()
    triggerRef.current?.focus()
  }

  const move = (direction: 1 | -1): void => {
    if (!open) {
      const firstEnabledIndex = options.findIndex((option) => !option.disabled)
      const lastEnabledIndex = options.reduce((lastIndex, option, index) => option.disabled ? lastIndex : index, -1)
      openMenu(direction === 1 ? firstEnabledIndex : lastEnabledIndex)
      return
    }
    let next = activeIndex
    for (let attempt = 0; attempt < options.length; attempt += 1) {
      next = (next + direction + options.length) % options.length
      if (!options[next]?.disabled) {
        setActiveIndex(next)
        return
      }
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if ((event.key === 'Enter' || event.key === ' ') && open && activeIndex >= 0) {
      event.preventDefault()
      const option = options[activeIndex]
      if (option) choose(option)
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
    }
  }

  useEffect(() => {
    if (!rendered) return
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu()
    }
    const closeForResize = (): void => closeMenu()
    const closeForExternalScroll = (event: Event): void => {
      const target = event.target
      if (target instanceof Node && menuRef.current?.contains(target)) return
      closeMenu()
    }
    document.addEventListener('pointerdown', closeOutside)
    window.addEventListener('resize', closeForResize)
    window.addEventListener('scroll', closeForExternalScroll, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('resize', closeForResize)
      window.removeEventListener('scroll', closeForExternalScroll, true)
    }
  }, [rendered])

  useEffect(() => () => {
    if (openFrameRef.current !== null) cancelAnimationFrame(openFrameRef.current)
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
  }, [])

  useLayoutEffect(() => {
    if (!rendered || activeIndex < 0) return
    const scroller = scrollRef.current
    const option = document.getElementById(`${listboxId}-${activeIndex}`)
    if (!scroller || !option) return
    const optionTop = option.offsetTop
    const optionBottom = optionTop + option.offsetHeight
    if (optionTop < scroller.scrollTop) scroller.scrollTop = optionTop
    else if (optionBottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = optionBottom - scroller.clientHeight
  }, [activeIndex, listboxId, rendered])

  return (
    <div className={compact ? 'settings-select compact' : 'settings-select'}>
      <button
        className={rendered ? 'settings-select-trigger attached' : 'settings-select-trigger'}
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={rendered ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        disabled={disabled || options.length === 0}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={handleKeyDown}
      >
        <span className={selectedOption ? undefined : 'placeholder'}>{selectedOption?.label ?? placeholder}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {rendered && position && createPortal(
        <div
          className={open ? 'settings-select-menu expanded' : 'settings-select-menu'}
          ref={menuRef}
          aria-hidden={!open}
          style={position}
          onTransitionEnd={(event) => {
            if (event.currentTarget === event.target && event.propertyName === 'grid-template-rows' && closingRef.current) finishClose()
          }}
        >
          <div className="settings-select-menu-clip">
            <div className="settings-select-menu-scroll" id={listboxId} ref={scrollRef} role="listbox" aria-label={label}>
              {options.map((option, index) => (
                <button
                  className={index === activeIndex ? 'settings-select-option active' : 'settings-select-option'}
                  id={`${listboxId}-${index}`}
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  disabled={option.disabled}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                >
                  <span>
                    <strong>{option.label}</strong>
                    {option.detail && <small>{option.detail}</small>}
                  </span>
                  {option.value === value && <Check aria-hidden="true" />}
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
