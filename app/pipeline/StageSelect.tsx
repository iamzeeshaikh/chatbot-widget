'use client'

// The no-drag path for changing a stage: a native select, so it is keyboard
// operable everywhere and is the ONLY mechanism on mobile (where the board is
// not rendered). Each option previews its stage colour, matching the record
// page's Deal control.

import { CRM_STAGES, CRM_STAGE_LABEL, CRM_STAGE_STYLE, CRM_STAGE_DOT, type CrmStage } from '@/lib/crm'

export default function StageSelect({ value, onChange, disabled, label, size = 'sm' }: {
  value: CrmStage
  onChange: (next: CrmStage) => void
  disabled?: boolean
  label: string
  size?: 'sm' | 'md'
}) {
  return (
    <>
      <label className="sr-only" htmlFor={`stage-${label}`}>{label}</label>
      <select
        id={`stage-${label}`}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value as CrmStage
          if (next !== value) onChange(next)
        }}
        style={{ boxShadow: `inset 3px 0 0 ${CRM_STAGE_DOT[value]}` }}
        className={`w-full font-semibold rounded-md border cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed ${CRM_STAGE_STYLE[value]} ${
          size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-1'
        }`}>
        {CRM_STAGES.map((s) => (
          <option key={s} value={s} className="bg-white font-semibold" style={{ color: CRM_STAGE_DOT[s] }}>
            {CRM_STAGE_LABEL[s]}
          </option>
        ))}
      </select>
    </>
  )
}
