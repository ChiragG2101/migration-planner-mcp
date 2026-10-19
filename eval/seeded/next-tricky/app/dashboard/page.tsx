import { getSession } from '../../server/session';

export default function DashboardPage() {
  const session = getSession();
  return <main>{session ? 'Welcome back' : 'Please sign in'}</main>;
}
