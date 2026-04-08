const merge = require('../merge');

describe('merge', () => {
  it('merges three sorted arrays into one sorted array', () => {
    const result = merge([1, 3, 5], [6, 4, 2], [7, 8, 9]);
    expect(result).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('handles empty arrays', () => {
    const result = merge([], [], [1, 2, 3]);
    expect(result).toEqual([1, 2, 3]);
  });

  it('handles all empty arrays', () => {
    const result = merge([], [], []);
    expect(result).toEqual([]);
  });
});

