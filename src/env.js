// These modules run both in Node (server.js) and in the browser (public/engine.js,
// for static hosting such as GitHub Pages). This hides the difference.
export const IN_NODE = Boolean(globalThis.process?.versions?.node);
export const env = globalThis.process?.env ?? {};
