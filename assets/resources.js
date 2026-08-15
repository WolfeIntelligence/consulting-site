// The design-tool runtime resolves its React dependency through this map and
// falls back to unpkg.com when an entry is missing. Serving both copies from
// our own origin keeps the site self-contained: no third-party CDN in the
// render path, nothing to leak a visitor's IP to, and a strict CSP that never
// needs to allow an external script host.
window.__resources = {
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js': 'assets/react.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js': 'assets/react-dom.js'
};
