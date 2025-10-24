import axios from 'axios';
import logger from '../logger.js';

export type TunnelEndpoint = {
  id: string;
  url: string;
  host?: string;
  port: number;
  secret_key: string;
};

type GetTunnelEndpointOpts = {
  url: string;
  apiKey?: string;
};

type GetTunnelEndpointResponse = {
  id: string;
  host?: string;
  port: number;
  secret_key: string;
  max_conn_count: number;
  url: string;
};

export async function getTunnelEndpoint({
  url,
  apiKey
}: GetTunnelEndpointOpts): Promise<TunnelEndpoint> {

  try {
    const response = await axios.post<GetTunnelEndpointResponse>(url, {
      responseType: 'json',
    }, {
      headers: {
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
        'Content-Type': 'application/json',
      },
    });

    logger.debug('Response data:' + response.data); // Debugging line

    return {
      id: response.data.id,
      url: response.data.url,
      host: response.data.host,
      port: response.data.port,
      secret_key: response.data.secret_key,
    };
  } catch (error) {
    logger.error('Error fetching tunnel endpoint:');
    logger.error(error);

    throw error;
  }

}

