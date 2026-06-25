    const genOffset = function* () {
      let index = 0;
      while (true) {
        yield index;
        index += 8;
      }
    }

var gen = genOffset(); // "Generator { }"

console.log(gen.next().value); // 0
console.log(gen.next().value); // 1
console.log(gen.next().value); // 2

var gen2 = genOffset();
console.log(gen.next().value);