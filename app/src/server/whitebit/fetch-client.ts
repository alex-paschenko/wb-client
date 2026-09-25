// app/src/server/whitebit/fetch-client.ts

import { FetchClient } from '../services/fetch-client.js';

const WHITEBIT_REQUEST_INTERVAL = 1_050;

export const whitebitFetchClient =
  new FetchClient(WHITEBIT_REQUEST_INTERVAL);
