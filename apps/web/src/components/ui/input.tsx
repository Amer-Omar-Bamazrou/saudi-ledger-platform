import * as React from "react"
import { cn } from "@/lib/utils"
import { useLanguage } from "@/contexts/LanguageContext"
import { ArabicDateInput, ArabicFileInput, ArabicMonthInput } from "@/components/ArabicPickers"

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    // Phase 18 final round (walk finding 13; register §11.142): a browser's date, month and file controls follow the
    // browser's language, not the app's. In Arabic these three render the localised pickers; everything else is unchanged.
    const { lang } = useLanguage()
    if (lang === "ar" && type === "date") return <ArabicDateInput {...props} className={className} ref={ref} />
    if (lang === "ar" && type === "month") return <ArabicMonthInput {...props} className={className} ref={ref} />
    if (lang === "ar" && type === "file") return <ArabicFileInput {...props} className={className} ref={ref} />
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
