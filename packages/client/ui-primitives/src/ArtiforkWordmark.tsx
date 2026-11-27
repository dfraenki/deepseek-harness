import type { IconProps } from './icons/props.ts'
import { ARTIFORK_MARK_PATH } from './ArtiforkMark.tsx'

/** Display options for the official brand wordmark. */
export interface ArtiforkWordmarkProps extends IconProps {
  /** Whether to include the leading mark; defaults to true. */
  includeMark?: boolean | undefined
}

/**
 * Render the full brand wordmark.
 * @param props.size - height in px (default 24; width follows the selected artwork).
 * @param props.className - extra class for layout placement.
 * @param props.includeMark - whether to include the leading mark.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function ArtiforkWordmark({ size = 24, className, includeMark = true }: ArtiforkWordmarkProps) {
  const width = includeMark ? 94 : 68
  return (
    <svg
      width={(size * width) / 24}
      height={size}
      className={className}
      viewBox={includeMark ? '0 0 94 24' : '26 0 68 24'}
      fill="none"
      aria-hidden="true"
    >
      {includeMark && (
        <g transform="translate(2 2) scale(0.026075)">
          <path d={ARTIFORK_MARK_PATH} fill="currentColor" fillRule="evenodd" />
        </g>
      )}
      <text
        x="27"
        y="17.6"
        fontFamily="'Montserrat', sans-serif"
        fontWeight={600}
        fontSize="16"
        fill="currentColor"
      >
        Artifork
      </text>
    </svg>
  )
}
