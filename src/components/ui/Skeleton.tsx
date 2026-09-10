import React from 'react';

type SkeletonShape = 'text' | 'circle' | 'rect' | 'card';

interface SkeletonProps {
  shape?: SkeletonShape;
  className?: string;
}

const shapeClasses: Record<SkeletonShape, string> = {
  text: 'h-4 rounded-md',
  circle: 'h-10 w-10 rounded-full',
  rect: 'h-11 rounded-xl',
  card: 'h-24 rounded-2xl',
};

/**
 * Subtle content-placeholder block for list/card loading states.
 * Deliberately quiet: brand-light-gray on the cream page background,
 * no shimmer sweep (a pulse is enough and costs nothing on low-end
 * devices). Compose skeletons from these primitives — e.g. a list row
 * is <Skeleton shape="circle"/> + a few <Skeleton shape="text"/>.
 */
export default function Skeleton({ shape = 'text', className = '' }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={`bg-brand-light-gray animate-pulse ${shapeClasses[shape]} ${className}`}
    />
  );
}
