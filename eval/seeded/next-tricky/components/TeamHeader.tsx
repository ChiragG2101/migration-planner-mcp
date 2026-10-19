'use client';

export default function TeamHeader({ params }: { params: { team: string } }) {
  return <h1>{params.team}</h1>;
}
