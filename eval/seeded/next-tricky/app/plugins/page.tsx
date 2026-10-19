export default async function PluginPage({ searchParams }: { searchParams: { name?: string } }) {
  const name = searchParams.name ?? 'default';
  const plugin = await import(`../../plugins/${name}`);
  return <div>{plugin.title}</div>;
}
