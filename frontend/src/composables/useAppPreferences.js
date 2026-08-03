import { computed, ref, watch } from 'vue'
import { publicAsset } from '../catalog.js'
import { locale, setLocale } from '../i18n.js'

function initialTheme() {
  try {
    const saved = localStorage.getItem('roundrelay-theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* noop */ }
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useAppPreferences() {
  const theme = ref(initialTheme())
  const productMark = computed(() => publicAsset(
    theme.value === 'dark' ? 'logos/meldwork-mark-v3-dark.svg' : 'logos/meldwork-mark-v3.svg',
  ))
  const productWordmark = computed(() => publicAsset(
    theme.value === 'dark' ? 'logos/meldwork-wordmark-v3-dark.svg' : 'logos/meldwork-wordmark-v3.svg',
  ))
  const productAppIcon = computed(() => publicAsset('logos/meldwork-app.png'))

  function applyTheme(value) {
    document.documentElement.dataset.theme = value
    document.documentElement.style.colorScheme = value
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', value === 'dark' ? '#0e171d' : '#f3f6f8')
    try { localStorage.setItem('roundrelay-theme', value) } catch { /* noop */ }
  }

  function toggleTheme() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
  }

  function toggleLocale() {
    setLocale(locale.value === 'zh' ? 'en' : 'zh')
  }

  watch(theme, applyTheme)

  return {
    applyTheme,
    productAppIcon,
    productMark,
    productWordmark,
    theme,
    toggleLocale,
    toggleTheme,
  }
}
