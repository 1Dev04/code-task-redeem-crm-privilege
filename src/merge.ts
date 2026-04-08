function merge(
  collection_1: number[],
  collection_2: number[],
  collection_3: number[]
): number[] {
  const result: number[] = [];

  let i = 0; // pointer for collection_1 (ascending)
  let j = collection_2.length - 1; // reverse pointer for collection_2
  let k = 0; // pointer for collection_3 (ascending)

  while (i < collection_1.length || j >= 0 || k < collection_3.length) {
    const v1 = i < collection_1.length ? collection_1[i]! : Infinity;
    const v2 = j >= 0 ? collection_2[j]! : Infinity;
    const v3 = k < collection_3.length ? collection_3[k]! : Infinity;

    const min = Math.min(v1, v2, v3);
    result.push(min);

    if (min === v1) {
      i++;
    } else if (min === v2) {
      j--;
    } else {
      k++;
    }
  }

  return result;
}

export = merge;