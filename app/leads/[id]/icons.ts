// Task-type → icon, kept in the UI layer on purpose.
//
// lib/tasks.ts also exports TASK_TYPE_ICON as emoji; that module is imported by
// the reminder sweep on the server, so it must stay free of React components.
// The record page maps to lucide here instead, which keeps one stroke weight and
// size across the whole page and leaves the shared module pure.

import { Phone, Mail, RefreshCw, Palette, Pin, type LucideIcon } from 'lucide-react'
import type { TaskType } from '@/lib/tasks'

export const TASK_ICON: Record<TaskType, LucideIcon> = {
  call: Phone,
  email: Mail,
  follow_up: RefreshCw,
  design: Palette,
  other: Pin,
}
