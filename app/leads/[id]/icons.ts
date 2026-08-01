// Task-type → icon, kept in the UI layer on purpose.
//
// lib/tasks.ts is imported by the reminder sweep on the server, so it must stay
// free of React components. The icon map therefore lives here, in the UI layer —
// which also keeps one stroke weight and size across the whole CRM.

import { Phone, Mail, RefreshCw, Palette, Pin, type LucideIcon } from 'lucide-react'
import type { TaskType } from '@/lib/tasks'

export const TASK_ICON: Record<TaskType, LucideIcon> = {
  call: Phone,
  email: Mail,
  follow_up: RefreshCw,
  design: Palette,
  other: Pin,
}
