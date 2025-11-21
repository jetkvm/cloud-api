import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import { streamToString, streamToBuffer, toSemverRange } from './helpers';

describe('streamToString', () => {
  it('should convert stream to string', async () => {
    const stream = Readable.from([Buffer.from('Hello'), Buffer.from(' '), Buffer.from('World')]);
    const result = await streamToString(stream);

    expect(result).toBe('Hello World');
  });

  it('should trim trailing whitespace', async () => {
    const stream = Readable.from([Buffer.from('test'), Buffer.from('  \n')]);
    const result = await streamToString(stream);

    expect(result).toBe('test');
  });

  it('should handle empty stream', async () => {
    const stream = Readable.from([]);
    const result = await streamToString(stream);

    expect(result).toBe('');
  });

  it('should handle UTF-8 characters', async () => {
    const stream = Readable.from([Buffer.from('Hello'), Buffer.from(' 世界')]);
    const result = await streamToString(stream);

    expect(result).toBe('Hello 世界');
  });
});

describe('streamToBuffer', () => {
  it('should convert stream to buffer', async () => {
    const stream = Readable.from([Buffer.from('Hello'), Buffer.from(' '), Buffer.from('World')]);
    const result = await streamToBuffer(stream);

    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString()).toBe('Hello World');
  });

  it('should handle empty stream', async () => {
    const stream = Readable.from([]);
    const result = await streamToBuffer(stream);

    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(0);
  });

  it('should handle binary data', async () => {
    const binaryData = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    const stream = Readable.from([binaryData]);
    const result = await streamToBuffer(stream);

    expect(result.toString()).toBe('Hello');
  });
});

describe('toSemverRange', () => {
  it('should return "*" for undefined input', () => {
    const result = toSemverRange(undefined);
    expect(result).toBe('*');
  });

  it('should return "*" for empty string', () => {
    const result = toSemverRange('');
    expect(result).toBe('*');
  });

  it('should return normalized valid semver range', () => {
    // semver.validRange normalizes ranges
    expect(toSemverRange('>=1.0.0')).toBe('>=1.0.0');
    expect(toSemverRange('^2.3.4')).toBe('>=2.3.4 <3.0.0-0'); // Normalized
    expect(toSemverRange('~1.2.3')).toBe('>=1.2.3 <1.3.0-0'); // Normalized
    expect(toSemverRange('1.0.0 - 2.0.0')).toBe('>=1.0.0 <=2.0.0'); // Normalized
  });

  it('should return "*" for invalid semver range', () => {
    expect(toSemverRange('invalid')).toBe('*');
    expect(toSemverRange('not-a-version')).toBe('*');
    expect(toSemverRange('abc123')).toBe('*');
  });

  it('should handle edge cases', () => {
    expect(toSemverRange('*')).toBe('*');
    expect(toSemverRange('latest')).toBe('*');
  });
});
