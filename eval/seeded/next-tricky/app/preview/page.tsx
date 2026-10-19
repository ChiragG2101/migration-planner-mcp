import { isPreview } from '@/server/preview';

export default function PreviewPage() {
  return <p>{isPreview() ? 'Preview' : 'Published'}</p>;
}
