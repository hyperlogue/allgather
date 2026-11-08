import { useState } from "react";
import { setTheme, useTheme } from "./theme.ts";

export function SettingsView() {
  const theme = useTheme();
  const [error, setError] = useState("");
  return (
    <section className="settings">
      <h1>Settings</h1>
      <fieldset className="appearance">
        <legend>Appearance</legend>
        <p className="muted">Choose light or dark mode for this browser.</p>
        <div className="theme-options">
          {(["light", "dark"] as const).map((mode) => (
            <label key={mode} className="theme-option">
              <span className={`theme-preview ${mode}`} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className="theme-label">
                <input
                  type="radio"
                  name="theme"
                  value={mode}
                  checked={theme === mode}
                  onChange={() =>
                    setError(
                      setTheme(mode)
                        ? ""
                        : "Your browser could not save this preference. It will apply until you reload.",
                    )
                  }
                />
                {mode === "light" ? "Light" : "Dark"}
              </span>
            </label>
          ))}
        </div>
        <p className="muted small" role="status">
          {error}
        </p>
      </fieldset>
    </section>
  );
}
