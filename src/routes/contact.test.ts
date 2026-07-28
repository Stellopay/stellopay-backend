import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config (so importing the route does not require STARKNET_RPC_URL) and
// nodemailer (so no real email is ever sent). env is mutable per-test.
const { envMock, sendMail } = vi.hoisted(() => ({
  envMock: {
    NODE_ENV: "development",
    EMAIL_USER: undefined as string | undefined,
    EMAIL_PASSWORD: undefined as string | undefined,
    CONTACT_RECIPIENT_EMAIL: undefined as string | undefined,
    RATE_LIMIT_CONTACT_WINDOW_MS: 60_000,
    RATE_LIMIT_CONTACT_MAX: 3,
  },
  sendMail: vi.fn(),
}));

vi.mock("../config.js", () => ({ env: envMock }));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

import { makeLimiter } from "../middleware/rate-limit";
import { contactRouter } from "./contact";

function makeApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  const contactLimiter = makeLimiter({
    name: "contact",
    windowMs: envMock.RATE_LIMIT_CONTACT_WINDOW_MS,
    max: envMock.RATE_LIMIT_CONTACT_MAX,
    message: "Too many contact form submissions. Please try again later.",
  });
  app.use("/api/v1/contact", contactLimiter);
  app.use("/api/v1", contactRouter);
  return app;
}

const valid = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  message: "Hello there",
};

beforeEach(() => {
  sendMail.mockReset().mockResolvedValue({});
  envMock.NODE_ENV = "development";
  envMock.EMAIL_USER = undefined;
  envMock.EMAIL_PASSWORD = undefined;
  envMock.CONTACT_RECIPIENT_EMAIL = undefined;
});

describe("POST /contact/send-message", () => {
  it("rejects missing fields with 400 and does not send", async () => {
    const res = await request(makeApp())
      .post("/api/v1/contact/send-message")
      .send({ firstName: "Ada" });
    expect(res.status).toBe(400);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("rejects an oversized message with 400", async () => {
    const res = await request(makeApp())
      .post("/api/v1/contact/send-message")
      .send({ ...valid, message: "x".repeat(5001) });
    expect(res.status).toBe(400);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("rejects an invalid email with 400", async () => {
    const res = await request(makeApp())
      .post("/api/v1/contact/send-message")
      .send({ ...valid, email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("dev-mode without credentials returns success without sending", async () => {
    const res = await request(makeApp()).post("/api/v1/contact/send-message").send(valid);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("production without a recipient returns 503 (no hardcoded address)", async () => {
    envMock.NODE_ENV = "production";
    envMock.EMAIL_USER = "sender@gmail.com";
    envMock.EMAIL_PASSWORD = "app-password";
    // CONTACT_RECIPIENT_EMAIL intentionally left unset
    const res = await request(makeApp()).post("/api/v1/contact/send-message").send(valid);
    expect(res.status).toBe(503);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("HTML-escapes user input and sends to the configured env recipient", async () => {
    envMock.EMAIL_USER = "sender@gmail.com";
    envMock.EMAIL_PASSWORD = "app-password";
    envMock.CONTACT_RECIPIENT_EMAIL = "team@stellopay.com";
    const res = await request(makeApp())
      .post("/api/v1/contact/send-message")
      .send({ ...valid, message: "<script>alert(1)</script>" });

    expect(res.status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe("team@stellopay.com");
    expect(mail.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(mail.html).not.toContain("<script>");
  });

  it("returns 500 when sending fails", async () => {
    envMock.EMAIL_USER = "sender@gmail.com";
    envMock.EMAIL_PASSWORD = "app-password";
    envMock.CONTACT_RECIPIENT_EMAIL = "team@stellopay.com";
    sendMail.mockRejectedValueOnce(new Error("smtp down"));
    const res = await request(makeApp()).post("/api/v1/contact/send-message").send(valid);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to send/);
  });

  it("in production, a send failure returns 500 without leaking error details", async () => {
    envMock.NODE_ENV = "production";
    envMock.EMAIL_USER = "sender@gmail.com";
    envMock.EMAIL_PASSWORD = "app-password";
    envMock.CONTACT_RECIPIENT_EMAIL = "team@stellopay.com";
    sendMail.mockRejectedValueOnce(new Error("smtp down"));
    const res = await request(makeApp()).post("/api/v1/contact/send-message").send(valid);
    expect(res.status).toBe(500);
    expect(res.body.details).toBeUndefined();
  });

  it("handles a non-Error rejection (no .message) and still returns 500", async () => {
    envMock.EMAIL_USER = "sender@gmail.com";
    envMock.EMAIL_PASSWORD = "app-password";
    envMock.CONTACT_RECIPIENT_EMAIL = "team@stellopay.com";
    sendMail.mockRejectedValueOnce("smtp exploded"); // a thrown string, not an Error
    const res = await request(makeApp()).post("/api/v1/contact/send-message").send(valid);
    expect(res.status).toBe(500);
  });
});

describe("Contact endpoint rate limiting", () => {
  it("allows requests up to the configured limit", async () => {
    envMock.RATE_LIMIT_CONTACT_MAX = 3;
    const app = makeApp();

    // First 3 requests should succeed
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post("/api/v1/contact/send-message").send(valid);
      expect(res.status).toBe(200);
    }
  });

  it("returns 429 with standard error envelope when limit is exceeded", async () => {
    envMock.RATE_LIMIT_CONTACT_MAX = 2;
    const app = makeApp();

    // First 2 requests succeed
    await request(app).post("/api/v1/contact/send-message").send(valid).expect(200);
    await request(app).post("/api/v1/contact/send-message").send(valid).expect(200);

    // Third request exceeds limit
    const res = await request(app).post("/api/v1/contact/send-message").send(valid);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      error: "Too many contact form submissions. Please try again later.",
    });
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("enforces rate limiting per IP address", async () => {
    envMock.RATE_LIMIT_CONTACT_MAX = 1;
    const app = makeApp();

    // Client A exhausts their single request
    await request(app)
      .post("/api/v1/contact/send-message")
      .set("X-Forwarded-For", "198.51.100.1")
      .send(valid)
      .expect(200);

    const resA = await request(app)
      .post("/api/v1/contact/send-message")
      .set("X-Forwarded-For", "198.51.100.1")
      .send(valid);
    expect(resA.status).toBe(429);

    // Client B (different IP) is unaffected
    const resB = await request(app)
      .post("/api/v1/contact/send-message")
      .set("X-Forwarded-For", "198.51.100.2")
      .send(valid);
    expect(resB.status).toBe(200);
  });

  it("preserves existing contact endpoint behaviour for valid requests", async () => {
    envMock.RATE_LIMIT_CONTACT_MAX = 10;
    const app = makeApp();

    // Valid request should still succeed with rate limiter applied
    const res = await request(app).post("/api/v1/contact/send-message").send(valid);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
