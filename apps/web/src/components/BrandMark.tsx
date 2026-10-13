export default function BrandMark(props: { size?: number; class?: string }) {
  const size = () => props.size ?? 28;
  return (
    <svg
      class={props.class ?? "brand-mark"}
      width={size()}
      height={size()}
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <rect x="5" y="9" width="11" height="2.6" rx="1.3" fill="currentColor" />
      <rect x="3" y="14.7" width="11" height="2.6" rx="1.3" fill="currentColor" opacity="0.8" />
      <rect x="7" y="20.4" width="6" height="2.6" rx="1.3" fill="currentColor" opacity="0.6" />
      <g class="brand-cursor" fill="var(--accent)">
        <rect x="21.7" y="5" width="3" height="22" rx="1" />
        <rect x="18.5" y="5" width="9.4" height="3" rx="1.2" />
        <rect x="18.5" y="24" width="9.4" height="3" rx="1.2" />
      </g>
    </svg>
  );
}
