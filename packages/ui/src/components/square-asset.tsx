import type { JSX } from 'react';
import { cn } from '../lib/cn.js';

/**
 * Every avatar, logo and item image, in a guaranteed square (§3.3).
 *
 * Three details carry the whole rule and all three are easy to drop:
 *   aspect-square    the box, not the image, decides the shape
 *   object-cover     fills the box and crops the excess instead of distorting
 *   overflow-hidden  without it the image spills past the rounded corners
 *
 * `rounded-lg` rather than a circle: a grid of rounded squares reads as a
 * system, a grid of circles reads as a contact list — and this grid is items.
 */
export type SquareAssetSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZE: Record<SquareAssetSize, string> = {
  xs: 'w-6',
  sm: 'w-8',
  md: 'w-9',
  lg: 'w-14',
  xl: 'w-20',
};

export interface SquareAssetProps {
  readonly src: string;
  readonly alt: string;
  readonly size?: SquareAssetSize;
  readonly className?: string;
}

export function SquareAsset({ src, alt, size = 'xl', className }: SquareAssetProps): JSX.Element {
  return (
    <div
      className={cn(
        'aspect-square shrink-0 overflow-hidden rounded-lg bg-muted',
        SIZE[size],
        className,
      )}
    >
      <img src={src} alt={alt} className="h-full w-full object-cover" />
    </div>
  );
}
