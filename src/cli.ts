import { Command } from 'commander';
import tnnlr from './lib/tnnlr.js';
import logger from './logger.js';
import ON_DEATH from 'death';

// yarn run start -p 80 --url https://lt.jobkit.dev --api-key your_api_key

const program = new Command();

program
  .name('tnnlr')
  .description('CLI for tunneling service')
  .version('0.1.0');

program
  .option('-p, --port <port>', 'Port to tunnel to')
  .option('--url <url>', 'URL to use to get tunnel endpoint')
  .option('--api-key <apiKey>', 'API key for authentication')
  .option('--local-host <host>', 'Local host to bind to', 'localhost')
  .option('--url-file <path>', 'Path to save the tunnel URL')
  .option('--max-connections <number>', 'Maximum number of concurrent connections', (value) => parseInt(value, 10), 10)
  .option('--retry <number>', 'Number of retries on failure', (value) => parseInt(value, 10), 3)
  .option('--retry-delay <seconds>', 'Delay between retries in seconds', (value) => parseFloat(value), 5.0);

program.parse();

const opts = {
  port: program.getOptionValue('port'),
  apiUrl: program.getOptionValue('url'),
  apiKey: program.getOptionValue('apiKey') || process.env.TNNLR_API_KEY,
  urlFile: program.getOptionValue('urlFile'),
  localHost: program.getOptionValue('localHost'),
  retry: program.getOptionValue('retry'),
  retryDelay: program.getOptionValue('retryDelay'),
  maxConnections: program.getOptionValue('maxConnections'),
};

if (!opts.port) {
  logger.error('Error: Port is required.');
  process.exit(1);
}

if (isNaN(Number(opts.port)) || Number(opts.port) <= 0 || Number(opts.port) > 65535) {
  logger.error('Error: Port must be a number between 1 and 65535.');
  process.exit(1);
}

if (!opts.apiUrl) {
  logger.error('Error: URL is required.');
  process.exit(1);
}

logger.info(`Starting tunnel to ${opts.apiUrl}:${opts.port}`);
logger.info(`Retry attempts: ${opts.retry}, Retry delay: ${opts.retryDelay} seconds`);

const shutdownSignal = new AbortController();

await Promise.race([
  new Promise(resolve => {
    ON_DEATH((signal) => {
      logger.info(`Termination signal ${signal} received — shutting down gracefully`);

      shutdownSignal.abort(); // signal other tasks to stop

      // give tasks up to 5s to finish
      try {
        setTimeout(resolve, 5000);
      } catch (e) {
        logger.warn('Error during shutdown: %s', e);
      } finally {
        process.exit(0);
      }
    });
  }),
  tnnlr({
    port: Number(opts.port),
    apiUrl: opts.apiUrl,
    apiKey: opts.apiKey,
    maxConnections: opts.maxConnections,
    retry: opts.retry,
    retryDelay: opts.retryDelay,
    onEndpoint: opts.urlFile ? ({ url }) => {
      import('fs').then(fs => {
        fs.writeFileSync(opts.urlFile, url);
        logger.info(`Tunnel URL written to ${opts.urlFile}`);
      });
    } : undefined,
    localHost: opts.localHost,
  })
]);

await tnnlr({
  port: Number(opts.port),
  apiUrl: opts.apiUrl,
  apiKey: opts.apiKey,
  maxConnections: opts.maxConnections,
  retry: opts.retry,
  retryDelay: opts.retryDelay,
  onEndpoint: opts.urlFile ? ({ url }) => {
    import('fs').then(fs => {
      fs.writeFileSync(opts.urlFile, url);
      logger.info(`Tunnel URL written to ${opts.urlFile}`);
    });
  } : undefined,
  localHost: opts.localHost,
}); 
