import { createLambdaHandler } from '@stacks/api/lambda';
import { manifest } from './manifest';
import { routes } from './routes';

export const handler = createLambdaHandler({ manifest, routes });
