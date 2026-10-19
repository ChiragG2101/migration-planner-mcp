type BadgeProps = { label?: string };

export function Badge({ label }: BadgeProps) {
  return <span className="badge">{label}</span>;
}

Badge.defaultProps = { label: 'new' };
