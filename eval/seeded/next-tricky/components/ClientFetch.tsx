'use client';

import { useEffect, useState } from 'react';

export function ClientFetch() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    fetch('/api/count').then((r) => r.json()).then((d) => setCount(d.count));
  }, []);
  return <span>{count}</span>;
}
