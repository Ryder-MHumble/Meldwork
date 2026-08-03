import { onBeforeUnmount, onMounted, ref } from 'vue'
import { mergeRunEvent, normalizeSnapshot } from '../desktop.js'

function settleWithin(promise, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

export function useDesktopWorkspaceLifecycle({
  afterInitialLoad,
  beforeBoot,
  defaultDirectory,
  handleOpenGroup,
  handleRunFinished,
  installer,
  installerState,
  provider,
  showError,
  snapshot,
  workspace,
}) {
  const booting = ref(true)
  const bridgeMissing = ref(false)
  let unsubscribeWorkspace = null
  let unsubscribeInstaller = null
  let unsubscribeRunFinished = null
  let unsubscribeRunEvent = null
  let unsubscribeOpenGroup = null

  function handleRunEvent(event) {
    const next = mergeRunEvent(snapshot.value, event)
    if (next !== snapshot.value) snapshot.value = next
  }

  async function boot() {
    beforeBoot()
    if (!workspace.value || !installer.value || !provider.value) {
      bridgeMissing.value = true
      booting.value = false
      return
    }
    try {
      unsubscribeWorkspace = workspace.value.onChanged?.((value) => {
        snapshot.value = normalizeSnapshot(value)
      }) || null
      unsubscribeRunEvent = workspace.value.onRunEvent?.(handleRunEvent) || null
      unsubscribeRunFinished = workspace.value.onRunFinished?.(handleRunFinished) || null
      unsubscribeOpenGroup = workspace.value.onOpenGroup?.(handleOpenGroup) || null
      unsubscribeInstaller = installer.value.onChanged?.((value) => {
        installerState.value = value
      }) || null
      const [nextSnapshot, nextInstaller, nextDirectory] = await Promise.all([
        settleWithin(workspace.value.get()),
        settleWithin(installer.value.state()),
        settleWithin(workspace.value.defaultDirectory()),
      ])
      if (nextSnapshot) snapshot.value = normalizeSnapshot(nextSnapshot)
      installerState.value = nextInstaller || installerState.value
      defaultDirectory.value = nextDirectory || ''
    } catch (error) {
      showError(error)
    } finally {
      booting.value = false
    }
    afterInitialLoad()
  }

  onMounted(() => {
    void boot()
  })

  onBeforeUnmount(() => {
    unsubscribeWorkspace?.()
    unsubscribeRunEvent?.()
    unsubscribeInstaller?.()
    unsubscribeRunFinished?.()
    unsubscribeOpenGroup?.()
  })

  return { booting, bridgeMissing }
}
