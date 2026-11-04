/**
 * 🔴 Arabic pickers (Phase 18 final round, walk finding 13; register §11.142).
 *
 * A browser's date, month and file controls follow the BROWSER's language, so an Arabic page read "mm/dd/yyyy",
 * "November 2026" and "No file chosen". In Arabic the native input stays in the DOM, holding the value, firing the form's
 * own onChange and keeping every test id, and a localised control sits over it. English keeps the native field.
 * Reached through the one seam every date field already uses, `components/ui/input.tsx`.
 */
import * as React from "react";
import { format, parseISO } from "date-fns";
import { arSA } from "react-day-picker/locale";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type NativeProps = React.InputHTMLAttributes<HTMLInputElement>;

const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

const FIELD = "flex h-full min-h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50";
const OVERLAY = "absolute inset-0 h-full w-full opacity-0 pointer-events-none";

/** Set a value on the native input so React's own onChange runs, exactly as if the user had typed it. */
function setNativeValue(el: HTMLInputElement, next: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function useNativeField(ref: React.ForwardedRef<HTMLInputElement>, props: NativeProps) {
  const inner = React.useRef<HTMLInputElement>(null);
  React.useImperativeHandle(ref, () => inner.current!);
  const [typed, setTyped] = React.useState(String(props.defaultValue ?? ""));
  const value = props.value !== undefined ? String(props.value ?? "") : typed;
  const onChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    setTyped(e.target.value);
    props.onChange?.(e);
  };
  return { inner, value, onChange };
}

/** `<input type="date">` in Arabic: the date in words, and the library's calendar with its Arabic locale. */
export const ArabicDateInput = React.forwardRef<HTMLInputElement, NativeProps>(({ className, style, ...props }, ref) => {
  const { inner, value, onChange } = useNativeField(ref, props);
  const [open, setOpen] = React.useState(false);
  const selected = /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseISO(value) : undefined;
  const hidden = { before: props.min ? parseISO(String(props.min)) : undefined, after: props.max ? parseISO(String(props.max)) : undefined };
  return (
    <div className={cn("relative block h-9 w-full", className)} style={style}>
      <input {...props} ref={inner} type="date" value={value} onChange={onChange} tabIndex={-1} className={OVERLAY} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={FIELD} disabled={props.disabled} data-date-picker="date">
            <span className={selected ? "" : "text-muted-foreground"}>{selected ? format(selected, "d MMMM yyyy", { locale: arSA }) : "اختر تاريخًا"}</span>
            <CalendarDays className="h-4 w-4 opacity-60 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start" data-date-picker-panel="date">
          <Calendar
            mode="single"
            dir="rtl"
            locale={arSA}
            selected={selected}
            defaultMonth={selected}
            disabled={[...(hidden.before ? [{ before: hidden.before }] : []), ...(hidden.after ? [{ after: hidden.after }] : [])]}
            onSelect={(d) => {
              if (inner.current) setNativeValue(inner.current, d ? format(d, "yyyy-MM-dd") : "");
              setOpen(false);
            }}
          />
          {value && !props.required && (
            <button type="button" className="w-full border-t border-border p-2 text-xs text-muted-foreground" onClick={() => { if (inner.current) setNativeValue(inner.current, ""); setOpen(false); }}>
              مسح التاريخ
            </button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
});
ArabicDateInput.displayName = "ArabicDateInput";

/** `<input type="month">` in Arabic: the month's name, and a year with its twelve months. */
export const ArabicMonthInput = React.forwardRef<HTMLInputElement, NativeProps>(({ className, style, ...props }, ref) => {
  const { inner, value, onChange } = useNativeField(ref, props);
  const [open, setOpen] = React.useState(false);
  const valid = /^\d{4}-\d{2}$/.test(value);
  const [year, setYear] = React.useState(() => (valid ? Number(value.slice(0, 4)) : new Date().getFullYear()));
  React.useEffect(() => { if (valid) setYear(Number(value.slice(0, 4))); }, [valid, value]);
  const label = valid ? `${MONTHS[Number(value.slice(5, 7)) - 1]} ${value.slice(0, 4)}` : "اختر شهرًا";
  const choose = (next: string) => {
    if (inner.current) setNativeValue(inner.current, next);
    setOpen(false);
  };
  return (
    <div className={cn("relative block h-9 w-full", className)} style={style}>
      <input {...props} ref={inner} type="month" value={value} onChange={onChange} tabIndex={-1} className={OVERLAY} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={FIELD} disabled={props.disabled} data-date-picker="month">
            <span className={valid ? "" : "text-muted-foreground"}>{label}</span>
            <CalendarDays className="h-4 w-4 opacity-60 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-3" align="start" dir="rtl" data-date-picker-panel="month">
          <div className="flex items-center justify-between pb-2">
            <button type="button" aria-label="السنة السابقة" className="p-1" onClick={() => setYear((y) => y - 1)}><ChevronRight className="h-4 w-4" /></button>
            <span className="font-mono text-sm">{year}</span>
            <button type="button" aria-label="السنة التالية" className="p-1" onClick={() => setYear((y) => y + 1)}><ChevronLeft className="h-4 w-4" /></button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {MONTHS.map((name, i) => {
              const month = `${year}-${String(i + 1).padStart(2, "0")}`;
              return (
                <button type="button" key={name} onClick={() => choose(month)}
                  className={cn("rounded-md px-1 py-1.5 text-xs hover:bg-secondary", month === value && "bg-primary text-primary-foreground")}>
                  {name}
                </button>
              );
            })}
          </div>
          {valid && !props.required && (
            <button type="button" className="mt-2 w-full border-t border-border pt-2 text-xs text-muted-foreground" onClick={() => choose("")}>مسح الشهر</button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
});
ArabicMonthInput.displayName = "ArabicMonthInput";

/** `<input type="file">` in Arabic: a labelled button and the chosen file's name. The native input keeps the file. */
export const ArabicFileInput = React.forwardRef<HTMLInputElement, NativeProps>(({ className, style, onChange, ...props }, ref) => {
  const [name, setName] = React.useState("");
  return (
    <label className={cn("inline-flex min-w-0 max-w-full cursor-pointer items-center gap-2 text-xs", className)} style={style} data-testid="file-picker">
      <input
        {...props}
        ref={ref}
        type="file"
        className="sr-only"
        onChange={(e) => {
          setName(e.target.files?.[0]?.name ?? "");
          onChange?.(e);
        }}
      />
      <span className="shrink-0 rounded-md border border-input bg-background px-3 py-1.5 font-medium">اختيار ملف</span>
      <span className="truncate text-muted-foreground">{name || "لم يُختر ملف"}</span>
    </label>
  );
});
ArabicFileInput.displayName = "ArabicFileInput";
