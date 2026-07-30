import autocannon from 'autocannon';
import http from 'http';
import { makeLimiter } from '../../src/middleware/rate-limit';

const PORT = 4005;
const MAX_REQUESTS = 50;
const WINDOW_MS = 10000;

const limiter = makeLimiter({ windowMs: WINDOW_MS, max: MAX_REQUESTS });

const server = http.createServer((req, res) => {
  const clientIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';
  
  const mockReq: any = {
    ip: clientIp,
    headers: req.headers,
    method: req.method,
    url: req.url,
  };

  const mockRes: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(key: string, val: string) {
      this.headers[key.toLowerCase()] = val;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      res.writeHead(this.statusCode, { 'Content-Type': 'application/json', ...this.headers });
      res.end(JSON.stringify(data));
    },
  };

  limiter(mockReq, mockRes, () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
});

async function runLoadSoakTest() {
  return new Promise<void>((resolve, reject) => {
    server.listen(PORT, async () => {
      console.log(`[Load/Soak] Server running on http://localhost:${PORT}`);
      console.log(`[Load/Soak] Starting concurrent multi-IP traffic load test...`);

      const instance = autocannon(
        {
          url: `http://localhost:${PORT}`,
          connections: 20,
          duration: 5,
          requests: [
            { method: 'GET', path: '/', headers: { 'x-forwarded-for': '192.168.1.1' } },
            { method: 'GET', path: '/', headers: { 'x-forwarded-for': '192.168.1.2' } },
          ],
        },
        (err, results) => {
          server.close();
          if (err) return reject(err);

          console.log('\n================ BENCHMARK RESULTS ================');
          console.log(`Throughput (req/sec): ${results.requests.average}`);
          console.log(`Avg Latency: ${results.latency.average} ms`);
          console.log(`2xx Responses: ${results['2xx']}`);
          console.log(`Non-2xx Responses: ${results['non2xx']}`);
          console.log('===================================================\n');
          resolve();
        }
      );

      autocannon.track(instance, { renderProgressBar: true });
    });
  });
}

runLoadSoakTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
