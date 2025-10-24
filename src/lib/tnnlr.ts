import ON_DEATH from 'death';
import { getTunnelEndpoint } from './endpoint.js';
import logger from '../logger.js';
import { createTunnel, type CreateTunnelOpts } from './tunnel.js';
import { sleep } from './utils.js';

type TnnlrOptions = {
  port: number;
  apiUrl: string;
  apiKey?: string;
  maxConnections: number;
  retry?: number;
  retryDelay?: number;
  localHost?: string;

  onEndpoint?: (endpoint: { url: string; port: number, secretKey: string }) => void;
}

const retryAsync = async <T>(fn: () => Promise<T>, retries: number, delayMs: number): Promise<T> => {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries) {
        throw err;
      }
      logger.warn(`Attempt ${attempt} failed. Retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }
  throw new Error('Unreachable code');
}

/**
 * Run createTunnel and restart it when it finishes/errors.
 * - retries: number of times to restart (undefined = infinite)
 * - retryDelay: milliseconds to wait between restarts
 */
async function runPersistentTunnel(
  id: number,
  opts: CreateTunnelOpts
): Promise<void> {
  let attempt = 0;

  while (true) {
    attempt += 1;

    logger.info(`Starting tunnel ${id} attempt ${attempt} to ${opts.remoteHost}:${opts.remotePort} -> ${opts.localHost}:${opts.localPort}`);

    try {
      await createTunnel(opts);

      logger.warn(`Tunnel ${id} attempt ${attempt} finished. Restarting...`);
      // continue to restart unless attempts exhausted
    } catch (err) {
      logger.error(`Tunnel attempt ${attempt} errored`);
      logger.error(err);
      // continue to retry unless attempts exhausted
    }
  }
}

const tnnlr = async (options: TnnlrOptions) => {
  // Placeholder for the tunneling logic
  logger.info(`Tunneling to ${options.apiUrl}:${options.port}`);

  const tunnelEndpoint = await retryAsync(() => getTunnelEndpoint({
    url: options.apiUrl,
    apiKey: options.apiKey,
  }), options.retry || 1, options.retryDelay ? options.retryDelay * 1000 : 5000);

  logger.debug(`Obtained tunnel endpoint: ${JSON.stringify(tunnelEndpoint)}`);

  if (options.onEndpoint) {
    options.onEndpoint({
      url: tunnelEndpoint.url,
      port: tunnelEndpoint.port,
      secretKey: tunnelEndpoint.secret_key,
    });
  }

  const remoteHost = new URL(options.apiUrl).hostname;

  const tunnels: Array<Promise<void>> = [];

  for (let i = 0; i < options.maxConnections; i++) {
    tunnels.push(runPersistentTunnel(i + 1, {
      remoteHost: remoteHost,
      remotePort: tunnelEndpoint.port,
      localHost: options.localHost || 'localhost',
      localPort: options.port,
      secretKey: tunnelEndpoint.secret_key,
      onRequest: (req) => {
        logger.info(`Received request: ${req.method} ${req.path}`);
      },
    }));
  }

  logger.info(`Tunnel established to ${tunnelEndpoint.url} on port ${tunnelEndpoint.port}`);

  await Promise.all(tunnels);
};

export default tnnlr;
export type { TnnlrOptions };
