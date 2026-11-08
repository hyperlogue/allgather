import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";
const key = "allgather-theme";
const event = "allgather-theme-change";
const current = (): Theme =>
  document.documentElement.classList.contains("dark") ? "dark" : "light";
function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  window.dispatchEvent(new Event(event));
}
function restore() {
  try {
    apply(localStorage.getItem(key) === "light" ? "light" : "dark");
  } catch {
    apply("dark");
  }
}
restore();
window.addEventListener("storage", (e) => {
  if (e.storageArea === localStorage && (e.key === key || e.key === null)) restore();
});
function subscribe(changed: () => void) {
  window.addEventListener(event, changed);
  return () => window.removeEventListener(event, changed);
}
export function useTheme() {
  return useSyncExternalStore(subscribe, current);
}
export function setTheme(theme: Theme) {
  apply(theme);
  try {
    localStorage.setItem(key, theme);
    return true;
  } catch {
    return false;
  }
}
