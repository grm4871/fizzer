type FizzerMarkProps = {
  size?: number;
  className?: string;
};

export function FizzerMark({ size = 16, className }: FizzerMarkProps) {
  return (
    <img
      src="/gem.svg"
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
