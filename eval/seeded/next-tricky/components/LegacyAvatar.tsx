import Image from 'next/legacy/image';

export function LegacyAvatar({ src }: { src: string }) {
  return <Image src={src} alt="" width={32} height={32} />;
}
