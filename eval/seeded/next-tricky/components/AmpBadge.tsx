import { useAmp } from 'next/amp';

export function AmpBadge() {
  const isAmp = useAmp();
  return isAmp ? <span>AMP</span> : null;
}
