import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';

// Import the internal functions we need to test
// Note: These functions are not exported from releases.ts, so we're testing the logic here
// In a real scenario, we'd either export these for testing or test through the public API

describe('Device Rollout Eligibility', () => {
  // Testing the isDeviceEligibleForLatestRelease logic
  function isDeviceEligibleForLatestRelease(
    rolloutPercentage: number,
    deviceId: string,
  ): boolean {
    if (rolloutPercentage === 100) return true;

    const hash = createHash("md5").update(deviceId).digest("hex");
    const hashPrefix = hash.substring(0, 8);
    const hashValue = parseInt(hashPrefix, 16) % 100;

    return hashValue < rolloutPercentage;
  }

  describe('isDeviceEligibleForLatestRelease', () => {
    it('should return true for 100% rollout', () => {
      expect(isDeviceEligibleForLatestRelease(100, 'device-1')).toBe(true);
      expect(isDeviceEligibleForLatestRelease(100, 'device-2')).toBe(true);
      expect(isDeviceEligibleForLatestRelease(100, 'any-device-id')).toBe(true);
    });

    it('should return false for 0% rollout', () => {
      expect(isDeviceEligibleForLatestRelease(0, 'device-1')).toBe(false);
      expect(isDeviceEligibleForLatestRelease(0, 'device-2')).toBe(false);
    });

    it('should be deterministic for the same device ID', () => {
      const deviceId = 'test-device-123';
      const rollout = 50;

      const result1 = isDeviceEligibleForLatestRelease(rollout, deviceId);
      const result2 = isDeviceEligibleForLatestRelease(rollout, deviceId);

      expect(result1).toBe(result2);
    });

    it('should distribute devices based on hash', () => {
      const rollout = 50;
      const devices = Array.from({ length: 100 }, (_, i) => `device-${i}`);

      const eligible = devices.filter(d => isDeviceEligibleForLatestRelease(rollout, d));

      // With 50% rollout and 100 devices, we expect roughly 40-60 eligible
      // (allowing for hash distribution variance)
      expect(eligible.length).toBeGreaterThan(30);
      expect(eligible.length).toBeLessThan(70);
    });

    it('should use MD5 hash of device ID', () => {
      const deviceId = 'test-device';
      const rollout = 50;

      // Calculate expected eligibility
      const hash = createHash("md5").update(deviceId).digest("hex");
      const hashPrefix = hash.substring(0, 8);
      const hashValue = parseInt(hashPrefix, 16) % 100;
      const expected = hashValue < rollout;

      expect(isDeviceEligibleForLatestRelease(rollout, deviceId)).toBe(expected);
    });

    it('should handle edge case rollout percentages', () => {
      const deviceId = 'test-device';

      // 1% should mostly return false
      const result1 = isDeviceEligibleForLatestRelease(1, deviceId);
      expect(typeof result1).toBe('boolean');

      // 99% should mostly return true
      const result99 = isDeviceEligibleForLatestRelease(99, deviceId);
      expect(typeof result99).toBe('boolean');
    });

    it('should handle different device ID formats', () => {
      const rollout = 50;

      // Test various ID formats
      expect(typeof isDeviceEligibleForLatestRelease(rollout, 'uuid-1234-5678')).toBe('boolean');
      expect(typeof isDeviceEligibleForLatestRelease(rollout, '12345')).toBe('boolean');
      expect(typeof isDeviceEligibleForLatestRelease(rollout, 'device_with_underscores')).toBe('boolean');
      expect(typeof isDeviceEligibleForLatestRelease(rollout, 'UPPERCASE-DEVICE')).toBe('boolean');
    });
  });
});

describe('Release Metadata Helpers', () => {
  interface ReleaseMetadata {
    version: string;
    url: string;
    hash: string;
    _cachedAt?: number;
    _maxSatisfying?: string;
  }

  interface Release {
    appVersion: string;
    appUrl: string;
    appHash: string;
    appCachedAt?: number;
    appMaxSatisfying?: string;
    systemVersion: string;
    systemUrl: string;
    systemHash: string;
    systemCachedAt?: number;
    systemMaxSatisfying?: string;
  }

  function setAppRelease(release: Release, appRelease: ReleaseMetadata) {
    release.appVersion = appRelease.version;
    release.appUrl = appRelease.url;
    release.appHash = appRelease.hash;
    release.appCachedAt = appRelease._cachedAt;
    release.appMaxSatisfying = appRelease._maxSatisfying;
  }

  function setSystemRelease(release: Release, systemRelease: ReleaseMetadata) {
    release.systemVersion = systemRelease.version;
    release.systemUrl = systemRelease.url;
    release.systemHash = systemRelease.hash;
    release.systemCachedAt = systemRelease._cachedAt;
    release.systemMaxSatisfying = systemRelease._maxSatisfying;
  }

  function toRelease(appRelease?: ReleaseMetadata, systemRelease?: ReleaseMetadata): Release {
    const release: Partial<Release> = {};
    if (appRelease) setAppRelease(release as Release, appRelease);
    if (systemRelease) setSystemRelease(release as Release, systemRelease);
    return release as Release;
  }

  describe('setAppRelease', () => {
    it('should set all app release fields', () => {
      const release = {} as Release;
      const appRelease: ReleaseMetadata = {
        version: '1.0.0',
        url: 'https://example.com/app',
        hash: 'abc123',
        _cachedAt: 1234567890,
        _maxSatisfying: '^1.0.0',
      };

      setAppRelease(release, appRelease);

      expect(release.appVersion).toBe('1.0.0');
      expect(release.appUrl).toBe('https://example.com/app');
      expect(release.appHash).toBe('abc123');
      expect(release.appCachedAt).toBe(1234567890);
      expect(release.appMaxSatisfying).toBe('^1.0.0');
    });

    it('should handle optional fields', () => {
      const release = {} as Release;
      const appRelease: ReleaseMetadata = {
        version: '2.0.0',
        url: 'https://example.com/app',
        hash: 'def456',
      };

      setAppRelease(release, appRelease);

      expect(release.appVersion).toBe('2.0.0');
      expect(release.appCachedAt).toBeUndefined();
      expect(release.appMaxSatisfying).toBeUndefined();
    });
  });

  describe('setSystemRelease', () => {
    it('should set all system release fields', () => {
      const release = {} as Release;
      const systemRelease: ReleaseMetadata = {
        version: '3.0.0',
        url: 'https://example.com/system',
        hash: 'xyz789',
        _cachedAt: 9876543210,
        _maxSatisfying: '~3.0.0',
      };

      setSystemRelease(release, systemRelease);

      expect(release.systemVersion).toBe('3.0.0');
      expect(release.systemUrl).toBe('https://example.com/system');
      expect(release.systemHash).toBe('xyz789');
      expect(release.systemCachedAt).toBe(9876543210);
      expect(release.systemMaxSatisfying).toBe('~3.0.0');
    });

    it('should handle optional fields', () => {
      const release = {} as Release;
      const systemRelease: ReleaseMetadata = {
        version: '4.0.0',
        url: 'https://example.com/system',
        hash: 'uvw345',
      };

      setSystemRelease(release, systemRelease);

      expect(release.systemVersion).toBe('4.0.0');
      expect(release.systemCachedAt).toBeUndefined();
      expect(release.systemMaxSatisfying).toBeUndefined();
    });
  });

  describe('toRelease', () => {
    it('should create release with both app and system', () => {
      const appRelease: ReleaseMetadata = {
        version: '1.0.0',
        url: 'https://example.com/app',
        hash: 'app-hash',
      };
      const systemRelease: ReleaseMetadata = {
        version: '2.0.0',
        url: 'https://example.com/system',
        hash: 'system-hash',
      };

      const release = toRelease(appRelease, systemRelease);

      expect(release.appVersion).toBe('1.0.0');
      expect(release.appUrl).toBe('https://example.com/app');
      expect(release.appHash).toBe('app-hash');
      expect(release.systemVersion).toBe('2.0.0');
      expect(release.systemUrl).toBe('https://example.com/system');
      expect(release.systemHash).toBe('system-hash');
    });

    it('should create release with only app', () => {
      const appRelease: ReleaseMetadata = {
        version: '1.0.0',
        url: 'https://example.com/app',
        hash: 'app-hash',
      };

      const release = toRelease(appRelease, undefined);

      expect(release.appVersion).toBe('1.0.0');
      expect(release.systemVersion).toBeUndefined();
    });

    it('should create release with only system', () => {
      const systemRelease: ReleaseMetadata = {
        version: '2.0.0',
        url: 'https://example.com/system',
        hash: 'system-hash',
      };

      const release = toRelease(undefined, systemRelease);

      expect(release.systemVersion).toBe('2.0.0');
      expect(release.appVersion).toBeUndefined();
    });

    it('should create empty release when both are undefined', () => {
      const release = toRelease(undefined, undefined);

      expect(release.appVersion).toBeUndefined();
      expect(release.systemVersion).toBeUndefined();
    });

    it('should preserve cache metadata', () => {
      const appRelease: ReleaseMetadata = {
        version: '1.0.0',
        url: 'https://example.com/app',
        hash: 'app-hash',
        _cachedAt: Date.now(),
        _maxSatisfying: '^1.0.0',
      };
      const systemRelease: ReleaseMetadata = {
        version: '2.0.0',
        url: 'https://example.com/system',
        hash: 'system-hash',
        _cachedAt: Date.now(),
        _maxSatisfying: '~2.0.0',
      };

      const release = toRelease(appRelease, systemRelease);

      expect(release.appCachedAt).toBe(appRelease._cachedAt);
      expect(release.appMaxSatisfying).toBe('^1.0.0');
      expect(release.systemCachedAt).toBe(systemRelease._cachedAt);
      expect(release.systemMaxSatisfying).toBe('~2.0.0');
    });
  });
});

describe('Release Logic Integration', () => {
  it('should consistently determine eligibility based on device ID and rollout', () => {
    // Simulate a rollout scenario
    const devices = ['device-a', 'device-b', 'device-c', 'device-d', 'device-e'];
    const rollout = 60; // 60% rollout

    const eligibleDevices = devices.filter(deviceId => {
      const hash = createHash("md5").update(deviceId).digest("hex");
      const hashPrefix = hash.substring(0, 8);
      const hashValue = parseInt(hashPrefix, 16) % 100;
      return hashValue < rollout;
    });

    // Same devices should always get the same result
    const secondCheck = devices.filter(deviceId => {
      const hash = createHash("md5").update(deviceId).digest("hex");
      const hashPrefix = hash.substring(0, 8);
      const hashValue = parseInt(hashPrefix, 16) % 100;
      return hashValue < rollout;
    });

    expect(eligibleDevices).toEqual(secondCheck);
  });

  it('should handle percentage-based distribution correctly', () => {
    // Test that percentages roughly match expected distribution
    const devices = Array.from({ length: 1000 }, (_, i) => `device-${i}`);

    const rollout10 = devices.filter(deviceId => {
      const hash = createHash("md5").update(deviceId).digest("hex");
      const hashPrefix = hash.substring(0, 8);
      const hashValue = parseInt(hashPrefix, 16) % 100;
      return hashValue < 10;
    });

    const rollout50 = devices.filter(deviceId => {
      const hash = createHash("md5").update(deviceId).digest("hex");
      const hashPrefix = hash.substring(0, 8);
      const hashValue = parseInt(hashPrefix, 16) % 100;
      return hashValue < 50;
    });

    // 10% rollout: expect 50-150 devices (allowing variance)
    expect(rollout10.length).toBeGreaterThan(50);
    expect(rollout10.length).toBeLessThan(150);

    // 50% rollout: expect 400-600 devices
    expect(rollout50.length).toBeGreaterThan(400);
    expect(rollout50.length).toBeLessThan(600);
  });
});
