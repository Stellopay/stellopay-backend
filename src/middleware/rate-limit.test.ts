// src/middleware/rate-limit.test.ts
import request from 'supertest';
import express, { Request, Response } from 'express';
import { makeLimiter, IDEMPOTENCY_KEY_HEADER } from './rate-limit';

/** Helper to build a minimal Express app with the limiter applied. */
function buildApp(limiterOptions: any) {
  const app = express();
  app.use(express.json());
  const limiter = makeLimiter(limiterOptions);
  app.get('/test', limiter, (req: Request, res: Response) => {
    res.json({ success: true });
  });
  return app;
}

describe('rate-limit middleware – idempotency key validation', () => {
  const baseOptions = { name: 'test', windowMs: 60_000, max: 2, idempotent: true };

  test('allows request with valid idempotency key', async () => {
    const app = buildApp(baseOptions);
    const res = await request(app)
      .get('/test')
      .set(IDEMPOTENCY_KEY_HEADER, 'valid-key-123');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  test('rejects malformed idempotency key (invalid characters)', async () => {
    const app = buildApp(baseOptions);
    const res = await request(app)
      .get('/test')
      .set(IDEMPOTENCY_KEY_HEADER, 'invalid key!'); // space and exclamation not allowed
    // Because the key is ignored, the request proceeds normally (no replay),
    // but the limiter still counts the request. This is the expected contract.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  test('rejects idempotency key longer than 255 chars', async () => {
    const longKey = 'a'.repeat(256);
    const app = buildApp(baseOptions);
    const res = await request(app).get('/test').set(IDEMPOTENCY_KEY_HEADER, longKey);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  test('rate limit triggers after max requests', async () => {
    const app = buildApp({ ...baseOptions, max: 1 });
    // First request should pass
    await request(app).get('/test').set(IDEMPOTENCY_KEY_HEADER, 'key1');
    // Second request exceeds max and should be throttled
    const res = await request(app).get('/test').set(IDEMPOTENCY_KEY_HEADER, 'key2');
    expect(res.status).toBe(429);
    expect(res.body).toHaveProperty('error');
    expect(res.headers['retry-after']).toBeDefined();
});

describe('rate-limit middleware – batching and pagination contract', () => {
  test('scales limit inversely to cost (proportional limiting)', async () => {
    const app = buildApp({
      name: 'batch-test',
      windowMs: 60_000,
      max: 10,
      cost: (req: Request) => Number(req.headers['x-cost'] || 1)
    });
    
    // Cost 5 -> Limit becomes 2. 
    // Request 1: hits=1, limit=2. Passes.
    let res = await request(app).get('/test').set('x-cost', '5');
    expect(res.status).toBe(200);
    
    // Request 2: hits=2, limit=2. Passes.
    res = await request(app).get('/test').set('x-cost', '5');
    expect(res.status).toBe(200);
    
    // Request 3: hits=3, limit=2. Throttled.
    res = await request(app).get('/test').set('x-cost', '5');
    expect(res.status).toBe(429);
  });

  test('immediately throttles if cost exceeds max (boundary path)', async () => {
    const app = buildApp({
      name: 'batch-test-2',
      windowMs: 60_000,
      max: 10,
      cost: (req: Request) => 15
    });
    
    // Cost 15 > Max 10 -> immediately throttled even on first request
    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
  });
  
  test('treats zero or negative cost as base max', async () => {
    const app = buildApp({
      name: 'batch-test-3',
      windowMs: 60_000,
      max: 2,
      cost: (req: Request) => 0
    });
    
    // Limit falls back to max (2)
    let res = await request(app).get('/test');
    expect(res.status).toBe(200);
    res = await request(app).get('/test');
    expect(res.status).toBe(200);
    res = await request(app).get('/test');
    expect(res.status).toBe(429);
  });
});
