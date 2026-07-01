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
    const unsubscribe = controller.subscribe(setState);

    controller.start();

    return () => {
      controller.stop();
      unsubscribe();
    };
  }, [controller]);

  return state;
};
