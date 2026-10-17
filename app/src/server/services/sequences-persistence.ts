// app/src/server/services/sequences-persistence.ts

import { pause } from '../../shared/utilities/awaiters.js';
import { sequencesDao } from '../dao/sequences.js';

class SequencesPersistence {
  public async getNextOrderId(): Promise<number> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await sequencesDao.getNextOrderId();
      } catch (error) {
        console.error('Cannot get WhiteBIT client order ID', {
          error, attempt: attempt + 1,
        });
        if (attempt < 3) {
          await pause(100 * 3 ** attempt);
        }
      }
    }
    
    return NaN;
  }
}

export const sequencesPersistence = new SequencesPersistence();
