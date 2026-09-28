/**
 * ThemeContext.tsx — light / dark.
 *
 * Closes design-pass-inherited-decisions D-2 ("is there a light theme at
 * all?"): yes. `:root` is LIGHT (white working surface) and `.dark` is the
 * dark palette; this provider is the one writer of the class on <html>.
 *
 * Persisted as `ksa_theme` ("light" | "dark"). Absent means LIGHT — the
 * owner's brief is a white working surface, so a first visit never inherits
 * a dark OS setting it did not ask for.
 *
 * The same key is read by a render-blocking script in index.html, so a dark
 * user never sees a white flash before React mounts. As with `ksa_lang`, both
 * are needed: the script paints the first frame, this provider owns changes.
 */
import { createContext, useContext, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const KEY = "ksa_theme";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  setTheme: () => {},
  toggle: () => {},
});

function readStored(): Theme {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  function setTheme(t: Theme) {
    setThemeState(t);
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* site data blocked — the choice lasts for this page only */
    }
  }

  return (
    <ThemeContext.Provider
      value={{ theme, setTheme, toggle: () => setTheme(theme === "dark" ? "light" : "dark") }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
