import { userAgent } from '@/server';

export default function AboutPage() {
  const agent = userAgent();
  return <p>You are browsing with {agent}</p>;
}
