import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

describe('Health Check Endpoint', () => {
  it('GET /health returns 200 with status ok and ISO timestamp', async () => {
    const app = createApp();
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('timestamp');
    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
  });

  it('GET /unknown-route returns 404 with LINK_NOT_FOUND error shape', async () => {
    const app = createApp();
    const res = await request(app).get('/unknown-route');

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toEqual({
      code: 'LINK_NOT_FOUND',
      message: 'Cannot GET /unknown-route',
    });
  });
});
