import { onBeforeUnmount, ref, watch } from 'vue'

export function useEmptyShowcasePlayback({
  visible,
  itemCount = 3,
  slideMs = 2800,
}) {
  const index = ref(0)
  let timer = null

  function clearPlayback() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function startPlayback() {
    clearPlayback()
    if (!visible.value || itemCount <= 1) return
    const step = () => {
      if (!visible.value) {
        clearPlayback()
        return
      }
      index.value = (index.value + 1) % itemCount
      timer = setTimeout(step, slideMs)
    }
    timer = setTimeout(step, slideMs)
  }

  watch(visible, (isVisible) => {
    if (isVisible) startPlayback()
    else clearPlayback()
  }, { flush: 'post' })

  onBeforeUnmount(clearPlayback)

  return { index }
}
