// A trivial module the fixture tests exercise. The L1 loop and permissions
// tests clone this fixture, run `node --test`, and apply patches to it.
export function add(a, b) {
  return a + b;
}
