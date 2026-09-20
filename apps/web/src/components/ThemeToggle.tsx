import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch — next-themes reads localStorage at runtime.
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <button
        className={cn(
          "flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border",
          "border-sidebar-border text-sidebar-foreground/50",
          className,
        )}
        aria-label="Toggle theme"
      >
        <Sun className="w-3 h-3" />
      </button>
    );
  }

  const isDark = theme === "dark";

  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={cn(
        "flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border transition-colors",
        isDark
          ? "border-sidebar-primary/50 text-sidebar-primary bg-sidebar-primary/10"
          : "border-sidebar-border text-sidebar-foreground/50 hover:text-sidebar-foreground hover:border-sidebar-foreground/40",
        className,
      )}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme"
    >
      {isDark ? <Sun className="w-3 h-3" /> : <Moon className="w-3 h-3" />}
      {isDark ? "☀" : "☾"}
    </button>
  );
}
