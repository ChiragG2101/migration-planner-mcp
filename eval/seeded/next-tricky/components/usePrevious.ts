import { useRef } from './reactApis';

export function usePrevious<T>(value: T) {
  const ref = useRef<T>();
  ref.current = value;
  return ref.current;
}
