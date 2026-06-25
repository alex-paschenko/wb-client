export const getGenerateSerials = (start: number, step: number) =>
  (function* (start, step) {
    let index = start;
    while (true) {
      yield index;
      index += step;
    }
  })(start, step);