import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import { describe, it, expect } from 'vitest';
import axios from 'axios';
import path from 'path';

const { string, boolean, eachLike } = MatchersV3;

describe('Capabilities Contract', () => {
  const provider = new PactV3({
    consumer: 'terminal',
    provider: 'controller',
    dir: path.resolve(process.cwd(), 'pacts'),
  });

  describe('GET /api/capabilities', () => {
    it('returns enterprise capabilities with valid auth', async () => {
      await provider
        .given('controller is running with enterprise license')
        .uponReceiving('a request for capabilities')
        .withRequest({
          method: 'GET',
          path: '/api/capabilities',
          headers: {
            Authorization: 'Bearer valid-token-123',
          },
        })
        .willRespondWith({
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
          body: {
            version: string('1.0'),
            license_tier: string('enterprise'),
            features: eachLike({
              name: string('central_ssh'),
              enabled: boolean(true),
            }),
          },
        })
        .executeTest(async (mockServer) => {
          // Force the native node HTTP adapter. The default in this JSDOM
          // test env is XHR, which sees the cross-origin custom Authorization
          // header and issues a CORS preflight (OPTIONS) that the Pact mock
          // doesn't model — the preflight fails with Network Error and the
          // real GET never runs.
          const response = await axios.get(`${mockServer.url}/api/capabilities`, {
            adapter: 'http',
            headers: {
              Authorization: 'Bearer valid-token-123',
            },
          });

          expect(response.status).toBe(200);
          expect(response.data).toHaveProperty('version');
          expect(response.data).toHaveProperty('license_tier');
          expect(response.data).toHaveProperty('features');
          expect(Array.isArray(response.data.features)).toBe(true);
          expect(response.data.features.length).toBeGreaterThan(0);
          expect(response.data.features[0]).toHaveProperty('name');
          expect(response.data.features[0]).toHaveProperty('enabled');
        });
    });
  });
});
