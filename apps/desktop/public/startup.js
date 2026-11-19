// Runs before the first paint so the startup skeleton follows the stored theme. It reads the
// settings the app saves under this key (SETTINGS_STORAGE_KEY in src/lib/settings.ts).
try {
  if (JSON.parse(localStorage.getItem("pude-settings-v1"))?.theme === "light") {
    document.documentElement.dataset.theme = "light";
  }
} catch {}
