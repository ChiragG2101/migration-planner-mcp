import { cookies } from 'next/headers';

export default function Page() {
  const theme = cookies().get('theme')?.value ?? 'light';
  return <main data-theme={theme}>Hello</main>;
}
