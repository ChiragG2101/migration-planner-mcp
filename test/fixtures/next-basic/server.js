// A custom server, which the scanner labels as a heuristic entrypoint.
const { createServer } = require('http');
const next = require('next');
const app = next({ dev: false });
app.prepare().then(() => createServer(app.getRequestHandler()).listen(3000));
