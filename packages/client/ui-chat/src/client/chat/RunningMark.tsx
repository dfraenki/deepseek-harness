/** Animated brand-mark mask and static SVG fallback for the running Chat status. */
import { ArtiforkMark } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ChatView.module.css'

/**
 * Render the decorative running icon; the APNG asset owns its animation timing.
 * @returns mask and static SVG selected by browser capabilities and accessibility preferences.
 */
export function RunningMark() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <span className={css.runningMarkAnimated} />
      <ArtiforkMark size={14} className={css.runningMarkStill} />
    </span>
  )
}
