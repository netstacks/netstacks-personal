import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import { describe, it, expect } from 'vitest';
import axios from 'axios';
import path from 'path';

const { string, uuid, integer } = MatchersV3;

describe('Auth Contract', () => {
  const provider = new PactV3({
    consumer: 'terminal',
    provider: 'controller',
    dir: path.resolve(process.cwd(), 'pacts'),
  });

  describe('POST /api/auth/login', () => {
    it('returns tokens for valid credentials', async () => {
      await provider
        .given('admin user exists')
        .uponReceiving('a login request with valid credentials')
        .withRequest({
          method: 'POST',
          path: '/api/auth/login',
          headers: {
            'Content-Type': 'application/json',
          },
          body: {
            email: string('admin@example.com'),
            password: string('password123'),
          },
        })
        .willRespondWith({
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
          body: {
            access_token: string('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'),
            refresh_token: string('refresh-token-123'),
            token_type: string('Bearer'),
            expires_in: integer(3600),
            user: {
              id: uuid('00000000-0000-0000-0000-000000000001'),
              email: string('admin@example.com'),
              name: string('Admin User'),
              role: string('admin'),
            },
          },
        })
        .executeTest(async (mockServer) => {
          const response = await axios.post(
            `${mockServer.url}/api/auth/login`,
            {
              email: 'admin@example.com',
              password: 'password123',
            },
            {
              headers: {
                'Content-Type': 'application/json',
              },
            }
          );

          expect(response.status).toBe(200);
          expect(response.data).toHaveProperty('access_token');
          expect(response.data).toHaveProperty('refresh_token');
          expect(response.data).toHaveProperty('token_type');
          expect(response.data).toHaveProperty('expires_in');
          expect(response.data).toHaveProperty('user');
          expect(response.data.user).toHaveProperty('email');
          expect(response.data.user).toHaveProperty('role');
        });
    });

    it('returns 401 for invalid credentials', async () => {
      await provider
        .given('admin user exists')
        .uponReceiving('a login request with invalid credentials')
        .withRequest({
          method: 'POST',
          path: '/api/auth/login',
          headers: {
            'Content-Type': 'application/json',
          },
          body: {
            email: string('admin@example.com'),
            password: string('wrongpassword'),
          },
        })
        .willRespondWith({
          status: 401,
          headers: {
            'Content-Type': 'application/json',
          },
          body: {
            error: string('invalid_credentials'),
          },
        })
        .executeTest(async (mockServer) => {
          try {
            await axios.post(
              `${mockServer.url}/api/auth/login`,
              {
                email: 'admin@example.com',
                password: 'wrongpassword',
              },
              {
                headers: {
                  'Content-Type': 'application/json',
                },
              }
            );
            expect.fail('Should have thrown error');
          } catch (error: any) {
            expect(error.response.status).toBe(401);
            expect(error.response.data).toHaveProperty('error');
          }
        });
    });

    it('returns 409 when all seats are in use', async () => {
      await provider
        .given('all seats in use')
        .uponReceiving('a login request when seats are full')
        .withRequest({
          method: 'POST',
          path: '/api/auth/login',
          headers: {
            'Content-Type': 'application/json',
          },
          body: {
            email: string('user@example.com'),
            password: string('password123'),
          },
        })
        .willRespondWith({
          status: 409,
          headers: {
            'Content-Type': 'application/json',
          },
          body: {
            error: string('seat_limit_reached'),
            seats_total: integer(10),
            seats_used: integer(10),
          },
        })
        .executeTest(async (mockServer) => {
          try {
            await axios.post(
              `${mockServer.url}/api/auth/login`,
              {
                email: 'user@example.com',
                password: 'password123',
              },
              {
                headers: {
                  'Content-Type': 'application/json',
                },
              }
            );
            expect.fail('Should have thrown error');
          } catch (error: any) {
            expect(error.response.status).toBe(409);
            expect(error.response.data).toHaveProperty('error');
            expect(error.response.data.error).toBe('seat_limit_reached');
            expect(error.response.data).toHaveProperty('seats_total');
            expect(error.response.data).toHaveProperty('seats_used');
          }
        });
    });
  });
});
