import TeamHeader from '../../components/TeamHeader';

export default function TeamLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { team: string };
}) {
  return (
    <div>
      <TeamHeader params={params} />
      {children}
    </div>
  );
}
