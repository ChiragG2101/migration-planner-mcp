import { cookies } from 'next/headers';

export default async function SettingsPage() {
  const store = await cookies();
  const theme = store.get('theme')?.value ?? 'light';
  return <section data-theme={theme}>Settings</section>;
}
