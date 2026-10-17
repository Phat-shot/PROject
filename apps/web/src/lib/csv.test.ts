import { describe, expect, it } from 'vitest';
import { toCsv } from './api';

describe('CSV-Export', () => {
  it('trennt mit Semikolon, maskiert Anführungszeichen und Zeilenumbrüche, beginnt mit BOM', () => {
    const csv = toCsv(['A', 'B'], [['x;y', 'sagt "hallo"'], [null, 'zwei\nZeilen'], [3, undefined]]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('\ufeffA;B');
    expect(lines[1]).toBe('"x;y";"sagt ""hallo"""');
    expect(lines[2]).toBe(';"zwei\nZeilen"');
    expect(lines[3]).toBe('3;');
  });
});
