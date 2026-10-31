// The usage-adapter registry: one `export { <pack>Adapter } from './<pack>.js'`
// line per pack, and nothing else. A new pack is registered by adding exactly
// one line here (D57). `index.ts` collects every export of this module with
// `Object.values`. A module namespace's keys are sorted alphabetically, not in
// export order; lookup is by adapter id, so that order is not part of the
// contract. Keeping registration to a single added line in a file that holds
// only re-exports is what lets `scripts/check-core-untouched.ts` enforce the
// "one new adapter, registered with one line" rule the M10 plan requires,
// without a pack PR editing engine logic. Keep this file to re-export lines only.
export { nextjsAdapter } from './nextjs.js';
