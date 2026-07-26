// Simplified toast hook
import * as React from "react"

export interface ToasterToast {
  id: string
  title?: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  variant?: "default" | "destructive"
}

let memoryState: ToasterToast[] = []
let listeners: Array<(state: ToasterToast[]) => void> = []

function dispatch(action: any) {
  memoryState = [action, ...memoryState].slice(0, 5)
  listeners.forEach((listener) => listener(memoryState))
}

export function toast(props: Omit<ToasterToast, "id">) {
  const id = Math.random().toString(36).slice(2)
  dispatch({ ...props, id })
  return {
    id,
    dismiss: () => {
      memoryState = memoryState.filter((t) => t.id !== id)
      listeners.forEach((listener) => listener(memoryState))
    },
  }
}

export function useToast() {
  const [toasts, setToasts] = React.useState<ToasterToast[]>(memoryState)

  React.useEffect(() => {
    listeners.push(setToasts)
    return () => {
      const index = listeners.indexOf(setToasts)
      if (index > -1) {
        listeners.splice(index, 1)
      }
    }
  }, [setToasts])

  return { toasts, toast }
}
