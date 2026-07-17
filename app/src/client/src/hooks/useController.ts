// app/src/client/src/hooks/useController.ts
import {
  useEffect,
  useState,
} from 'react';

import type {
  BaseController,
} from '../controllers/BaseController';

export const useController = <TState,>(
  controller: BaseController<TState>,
): TState => {
  const [state, setState] = useState(() => controller.getState());

  useEffect(() => {
    return controller.subscribe(setState);
  }, [controller]);

  return state;
};
