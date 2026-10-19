export async function GET() {
  const res = await fetch('https://api.example.com/feed');
  const items = await res.json();
  return Response.json({ items });
}
