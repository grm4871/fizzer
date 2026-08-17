import net from 'node:net';

/**
 * Ports the WHATWG fetch spec refuses to connect to. A server can bind them
 * happily, so a harness that picks one looks like "the app never came up"
 * when really `fetch` rejected with "bad port". 4190 (ManageSieve) is the one
 * that actually lands in our 4xxx preview range.
 */
const BAD_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665,
  6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Ask the OS for a free port, so a leftover dev server (or a parallel run)
 * cannot fail the harness with a confusing "already in use" / timeout.
 */
export async function pickPort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await freePort();
    if (!BAD_PORTS.has(port)) return port;
  }
  throw new Error('Could not find a free port');
}
