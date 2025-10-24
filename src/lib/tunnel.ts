import EventEmitter from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import { Duplex, Transform } from 'node:stream';
import { isErrnoException } from './utils.js';
import logger from '../logger.js';

type ConnectLocalOpts = {
  host: string;
  port: number;
  allowInvalidCert: boolean;
  https: boolean;
  certFile: string;
  keyFile: string;
  caFile?: string;
}

export type CreateTunnelOpts = {
  remoteHost: string;
  remotePort: number;
  localHost: string;
  localPort: number;
  secretKey?: string;
  authTimeoutMs?: number;
  onRequest?: (req: { method?: string; path?: string }) => void;
};

function connectLocal({
  host,
  port,
  allowInvalidCert,
  https,
  certFile,
  keyFile,
  caFile,
}: ConnectLocalOpts) {
  const emitter = new EventEmitter();

  const getLocalCertOpts = () =>
    allowInvalidCert
      ? { rejectUnauthorized: false }
      : {
        cert: fs.readFileSync(certFile),
        key: fs.readFileSync(keyFile),
        ca: caFile ? [fs.readFileSync(caFile)] : undefined,
      };

  // connection to local http server
  const localSocket = https
    ? tls.connect({ host, port, ...getLocalCertOpts() })
    : net.connect({ host, port });

  localSocket.on('connect', () => {
    logger.info(`Connected to local server at ${host}:${port}`);

    emitter.emit('connected', { host, port });
  });

  localSocket.on('data', (data) => {
    logger.info('Received data from local server:', data.toString());

    emitter.emit('data', data);
  });

  localSocket.on('error', (err) => {
    emitter.emit('error', err);

    localSocket.end();
  });

  localSocket.on('close', () => {
    emitter.emit('close');
  });

  return {
    emitter,
    socket: localSocket,
  };
}

async function authenticateRemote(socket: net.Socket, secretKey: string | undefined, timeoutMs = 5000): Promise<void> {
  if (!secretKey) return;

  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      cleanup();
      reject(new Error('Authentication timed out'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function onClose() {
      cleanup();
      reject(new Error('Socket closed before authentication'));
    }

    function onData(chunk: Buffer) {
      const s = chunk.toString().trim();

      logger.debug('Received data from remote: %s', s);

      // Accept a few common success indicators; adjust to server protocol if needed
      if (s === 'AUTH_OK' || s === 'AUTH_SUCCESS' || /"status"\s*:\s*"ok"/i.test(s)) {
        cleanup();
        resolve();
      } else if (s === 'AUTH_FAIL' || /"status"\s*:\s*"error"/i.test(s)) {
        cleanup();
        reject(new Error('Authentication failed'));
      } else {
        // ignore unrelated data and keep waiting until timeout or a definite response
      }
    }

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);

    // send auth frame (do not log the secret)
    try {
      const payload = JSON.stringify({ type: 'auth', key: secretKey }) + '\n';

      logger.debug('Sending authentication payload to remote: %s', payload.trim());

      socket.write(payload, 'utf8');
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

/**
 * Wait for the remote socket to send a line containing "READY".
 * Returns any buffered bytes that come after the READY line (may be empty).
 */
function waitForReady(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);

    function cleanup() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function onClose() {
      cleanup();
      reject(new Error('Socket closed before READY'));
    }

    function onData(chunk: Buffer) {
      buf = Buffer.concat([buf, chunk]);

      // treat control lines as newline-delimited; search for newline
      let nlIndex = buf.indexOf(0x0a); // '\n'

      while (nlIndex !== -1) {
        const line = buf.slice(0, nlIndex).toString().trim();
        const remainder = buf.slice(nlIndex + 1);

        logger.debug('Received control line from remote: %s', line);

        if (line === 'READY') {
          cleanup();
          resolve(remainder);

          return;
        } else if (line === 'PING') {
          logger.debug('Responding to PING with PONG');
          // respond to PING with PONG
          socket.write('PONG\n', 'utf8');

          // remove processed line from buffer and continue processing any further lines
          buf = remainder;
          nlIndex = buf.indexOf(0x0a); // '\n'

          continue;
        } else {
          // not READY or PING — keep buffering but guard against unbounded growth
          if (buf.length > 64 * 1024) {
            // avoid unlimited buffer growth; treat as protocol error
            cleanup();
            reject(new Error('Unexpected data before READY'));

            return;
          }
          // we have data that isn't a control line yet — wait for more bytes
          break;
        }
      }
    }

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

export async function createTunnel({
  remoteHost,
  remotePort,
  localHost,
  localPort,
  secretKey,
  authTimeoutMs,
  onRequest
}: CreateTunnelOpts): Promise<void> {
  const emitter = new EventEmitter();

  const remoteSocket = net.createConnection(
    { host: remoteHost, port: remotePort, keepAlive: true },
    async () => {
      logger.info(`Connected to tunnel at ${remoteHost}:${remotePort}`);

      try {
        await authenticateRemote(remoteSocket, secretKey, authTimeoutMs);
        logger.info('Remote authentication succeeded');
      } catch (err) {
        logger.error('Remote authentication failed');
        emitter.emit('error', err);
        remoteSocket.end();
        return;
      }

      //remoteSocket.pause();

      // wait for remote READY, capture any trailing bytes after READY so they
      // can be forwarded to the local socket when piping starts.
      let postReadyBuffer: Buffer = Buffer.alloc(0);
      try {
        postReadyBuffer = await waitForReady(remoteSocket);
        logger.debug('Received READY from remote');
      } catch (err) {
        logger.error('Did not receive READY from remote: %s', err);
        emitter.emit('error', err);
        remoteSocket.end();
        return;
      }

      const {
        emitter: localEmitter,
        socket: localSocket,
      } = connectLocal({
        host: localHost,
        port: localPort,
        allowInvalidCert: true,
        https: false,
        certFile: '',
        keyFile: '',
      });

      localEmitter.on('connected', (info) => {
        emitter.emit('connected', info);

        //remoteSocket.resume();

        // pipe the local socket to the remote socket
        let stream: Duplex = remoteSocket;

        // if user requested specific local host
        // then we use host header transform to replace the host header
        if (localHost !== 'localhost' && localHost !== '127.0.0.1') {
          logger.debug('transform Host header to %s', localHost);
          stream = remoteSocket.pipe(createHeaderHostTransformer(localHost));
        }

        stream.pipe(localSocket).pipe(remoteSocket);

        // when local closes, also get a new remote
        localSocket.once('close', hadError => {
          logger.debug('local connection closed [%s]', hadError);
        });
      });

      localEmitter.on('error', (err) => {
        if (isErrnoException(err) === false) {
          logger.error('Unknown error on local socket:');
          logger.error(err);
          return;
        }

        if (err.code === 'ECONNREFUSED') {
          logger.error('Connection refused by the local server');
        } else {
          logger.error(`Local socket error (${err.code}): ${err.message}`);
        }

        remoteSocket.end();

        emitter.emit('error', err);
      });

      localEmitter.on('close', () => {
        logger.info('Local connection closed');
      });
    });

  remoteSocket.on('data', (data) => {
    logger.debug(`Received data from tunnel: ${data.toString()}`);

    const match = data.toString().match(/^(\w+) (\S+)/);
    if (match) {
      onRequest?.({
        method: match[1],
        path: match[2],
      });
    }
  });

  return new Promise((resolve, reject) => {

    emitter.on('error', (err) => {
      reject(err);
    });

    remoteSocket.on('error', (err) => {
      if (isErrnoException(err) === false) {
        logger.error('Unknown error on remote socket:');
        logger.error(err);
        return;
      }

      // emit connection refused errors immediately, because they
      // indicate that the tunnel can't be established.
      if (err.code === 'ECONNREFUSED') {
        logger.error('Connection refused by the server');

        //emitter.emit('error', new Error('Connection refused by the server'));
        reject(new Error('Connection refused by the server'));

        remoteSocket.end();
        return;
      } else {
        logger.error(`Socket error (${err.code}): ${err.message}`);
      }

      remoteSocket.end();

      reject(err);
    });

    remoteSocket.on('close', () => {
      logger.info('Tunnel connection closed');

      resolve();
    });
  });
}

const createHeaderHostTransformer = (host: string) => {
  let replaced = false;

  return new Transform({
    transform(chunk, encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);

      callback(
        null,
        replaced // after replacing the first instance of the Host header we just become a regular passthrough
          ? data
          : data.toString().replace(/(\r\n[Hh]ost: )\S+/, (match, $1) => {
            replaced = true;
            return $1 + host;
          })
      );
    },
  });
};
