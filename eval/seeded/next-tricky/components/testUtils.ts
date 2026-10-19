import { act } from 'react-dom/test-utils';

export async function flush(): Promise<void> {
  await act(async () => {});
}
