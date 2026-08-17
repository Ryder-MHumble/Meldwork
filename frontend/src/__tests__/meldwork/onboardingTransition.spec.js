import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('onboarding transition', () => {
  it('keeps a stable full-screen root around the dialog during leave', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.vue'), 'utf8')
    const styles = readFileSync(resolve(process.cwd(), 'src/styles/base-onboarding.css'), 'utf8')

    expect(appSource).toMatch(
      /<transition name="onboarding" appear>\s*<div v-if="onboardingVisible" class="onboarding-transition-shell">\s*<OnboardingDialog/s,
    )
    expect(styles).toMatch(
      /\.onboarding-transition-shell\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*z-index:\s*110;/s,
    )
    expect(styles).toMatch(/\.onboarding-leave-active\s*\{[^}]*transition:\s*opacity 0\.42s ease;/s)
    expect(styles).toMatch(/\.onboarding-leave-to \.onboarding-backdrop\s*\{[^}]*background-color:\s*rgb\(13 17 23 \/ 0\);/s)
    expect(styles).toMatch(
      /\.onboarding-leave-to \.onboarding-dialog\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*translateY\(14px\) scale\(0\.975\);/s,
    )
  })
})
