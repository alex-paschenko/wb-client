import type { QueryFragment } from '../db/client';

export interface SelectParams {
  from?: QueryFragment;
  where?: QueryFragment;
  orderBy?: QueryFragment;
  limit?: number;
  offset?: number;
}
