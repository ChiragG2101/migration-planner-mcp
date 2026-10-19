import { useRef } from 'react';

export function useTimer() {
  const id = useRef<number>();
  return id;
}
