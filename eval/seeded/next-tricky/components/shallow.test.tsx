import ShallowRenderer from 'react-test-renderer/shallow';

export function renderShallow() {
  const renderer = new ShallowRenderer();
  renderer.render(<span>Badge</span>);
  return renderer.getRenderOutput();
}
